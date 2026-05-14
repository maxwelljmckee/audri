// Automations REST surface — backs the C3 Automations tile.
//
// Endpoints:
//   GET    /automations/suggested      catalog the mobile renders under "Suggested"
//   GET    /automations                user's recurring_agent_tasks rows
//   POST   /automations                instantiate from catalog (toggle suggested ON)
//   PATCH  /automations/:id            edit schedule, pause/resume, payload
//   DELETE /automations/:id            soft-delete (tombstone)
//
// Backed by recurring_agent_tasks (see packages/shared/.../automations.ts).
// The worker's dispatch-recurring sweep fires these rows at next_run_at.
//
// Schema/runtime invariants the controller upholds:
//   - One ACTIVE row per (user_id, kind, suggested_id) — enforced by
//     a partial unique index, so duplicate POST returns 409.
//   - next_run_at = null when paused=true (dispatcher uses
//     IS NOT NULL as the readiness filter).
//   - Schedule edits + pause→unpause recompute next_run_at via the
//     shared `computeNextRunAt` helper.

import {
  AUTOMATION_CATALOG,
  type ScheduleSpec,
  computeNextRunAt,
  findSuggestedAutomation,
} from '@audri/shared/automations';
import {
  agents,
  and,
  db,
  desc,
  eq,
  isNull,
  recurringAgentTasks,
  sql,
} from '@audri/shared/db';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { CurrentUser } from '../auth/user.decorator.js';

// ── DTOs ─────────────────────────────────────────────────────────────────

interface InstantiateAutomationBody {
  kind: string;
  suggested_id: string;
  // Optional override for dreaming-kind, which needs an agent.
  // Omitted → server picks the user's default agent.
  agent_id?: string | null;
}

interface PatchAutomationBody {
  days_of_week?: number[];
  times?: string[];
  timezone?: string;
  jitter_minutes?: number;
  paused?: boolean;
  payload?: Record<string, unknown>;
}

interface AutomationRowDTO {
  id: string;
  kind: string;
  suggested_id: string | null;
  agent_id: string | null;
  days_of_week: number[];
  times: string[];
  timezone: string;
  jitter_minutes: number;
  payload: unknown;
  trigger_mode: string;
  paused: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_agent_task_id: string | null;
  created_at: string;
  updated_at: string;
}

// ── Controller ───────────────────────────────────────────────────────────

@Controller('automations')
@UseGuards(SupabaseAuthGuard)
export class AutomationsController {
  private readonly logger = new Logger(AutomationsController.name);

  @Get('suggested')
  async listSuggested() {
    // Single source of truth: shared catalog. Mobile renders the
    // "Suggested" tab from this payload — kinds become section
    // headers, suggested[] become per-row toggles.
    return { catalog: AUTOMATION_CATALOG };
  }

  @Get()
  async listActive(@CurrentUser() user: { id: string }) {
    const rows = await db
      .select()
      .from(recurringAgentTasks)
      .where(
        and(
          eq(recurringAgentTasks.userId, user.id),
          isNull(recurringAgentTasks.tombstonedAt),
        ),
      )
      .orderBy(desc(recurringAgentTasks.createdAt));
    return { rows: rows.map(rowToDTO) };
  }

  @Post()
  async instantiate(
    @CurrentUser() user: { id: string },
    @Body() body: InstantiateAutomationBody,
  ) {
    const kind = (body.kind ?? '').trim();
    const suggestedId = (body.suggested_id ?? '').trim();
    if (!kind || !suggestedId) {
      throw new BadRequestException('kind and suggested_id required');
    }
    const suggestion = findSuggestedAutomation(kind, suggestedId);
    if (!suggestion) {
      throw new BadRequestException(
        `unknown suggested automation: kind=${kind} suggested_id=${suggestedId}`,
      );
    }

    // Dreaming requires an agent. For other kinds we ignore any
    // provided agent_id since they're app-level — keeps the
    // recurring row's intent unambiguous.
    let agentId: string | null = null;
    if (kind === 'dreaming') {
      agentId = body.agent_id ?? (await resolveDefaultAgentId(user.id));
      if (!agentId) {
        throw new BadRequestException(
          'no default agent available; cannot instantiate dreaming automation',
        );
      }
    }

    const timezone = await resolveUserTimezone(user.id);
    const jitterMinutes = suggestion.defaultSchedule.jitterMinutes ?? 30;

    // INSERT first to obtain the row id (jitter is per-row-stable),
    // then immediately UPDATE next_run_at. Two-step lets us feed the
    // real row id into computeNextRunAt — using a placeholder would
    // produce a different jitter offset than the dispatcher later
    // calculates, and we want the same offset throughout the row's
    // lifetime.
    try {
      const [inserted] = await db
        .insert(recurringAgentTasks)
        .values({
          userId: user.id,
          agentId,
          // biome-ignore lint/suspicious/noExplicitAny: kind is the agent_task_kind pgEnum
          kind: kind as any,
          suggestedId,
          triggerMode: 'cron',
          daysOfWeek: suggestion.defaultSchedule.daysOfWeek,
          times: suggestion.defaultSchedule.times,
          timezone,
          jitterMinutes,
          payload: suggestion.defaultPayload ?? {},
          paused: false,
        })
        .returning();
      if (!inserted) {
        throw new Error('insert returned no row');
      }

      const nextRunAt = computeNextRunAt(
        {
          daysOfWeek: inserted.daysOfWeek,
          times: inserted.times,
          timezone: inserted.timezone,
          jitterMinutes: inserted.jitterMinutes,
        },
        { userId: user.id, recurringTaskId: inserted.id },
      );
      const [updated] = await db
        .update(recurringAgentTasks)
        .set({ nextRunAt, updatedAt: new Date() })
        .where(eq(recurringAgentTasks.id, inserted.id))
        .returning();

      this.logger.log(
        { userId: user.id, kind, suggestedId, recurringId: inserted.id, nextRunAt },
        'automation instantiated',
      );
      return { row: rowToDTO(updated ?? inserted) };
    } catch (err) {
      // Unique-constraint violation = a row already exists for
      // (user, kind, suggested_id) that isn't tombstoned. Return 409
      // so the client can surface "already active" cleanly.
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `automation already active for kind=${kind} suggested_id=${suggestedId}`,
        );
      }
      throw err;
    }
  }

  @Patch(':id')
  async patch(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() body: PatchAutomationBody,
  ) {
    const existing = await loadOwn(user.id, id);
    // Build the update set. We only touch columns the caller named —
    // partial patch semantics. Schedule edits + pause toggles force a
    // next_run_at recompute.
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    let scheduleChanged = false;

    if (body.days_of_week !== undefined) {
      if (!Array.isArray(body.days_of_week)) {
        throw new BadRequestException('days_of_week must be an int[]');
      }
      patch.daysOfWeek = body.days_of_week;
      scheduleChanged = true;
    }
    if (body.times !== undefined) {
      if (!Array.isArray(body.times) || body.times.some((t) => !/^\d{2}:\d{2}$/.test(t))) {
        throw new BadRequestException('times must be ["HH:MM", ...]');
      }
      patch.times = body.times;
      scheduleChanged = true;
    }
    if (body.timezone !== undefined) {
      if (typeof body.timezone !== 'string') throw new BadRequestException('timezone must be a string');
      patch.timezone = body.timezone;
      scheduleChanged = true;
    }
    if (body.jitter_minutes !== undefined) {
      if (typeof body.jitter_minutes !== 'number' || body.jitter_minutes < 0) {
        throw new BadRequestException('jitter_minutes must be a non-negative number');
      }
      patch.jitterMinutes = body.jitter_minutes;
      scheduleChanged = true;
    }
    if (body.payload !== undefined) patch.payload = body.payload;
    if (body.paused !== undefined) {
      patch.paused = body.paused;
      if (body.paused) patch.nextRunAt = null; // paused → clear next_run_at
    }

    // Recompute next_run_at if schedule changed OR if unpausing.
    const unpausing = body.paused === false && existing.paused === true;
    if (scheduleChanged || unpausing) {
      const spec: ScheduleSpec = {
        daysOfWeek: (patch.daysOfWeek as number[] | undefined) ?? existing.daysOfWeek,
        times: (patch.times as string[] | undefined) ?? existing.times,
        timezone: (patch.timezone as string | undefined) ?? existing.timezone,
        jitterMinutes:
          (patch.jitterMinutes as number | undefined) ?? existing.jitterMinutes,
      };
      patch.nextRunAt = computeNextRunAt(spec, {
        userId: user.id,
        recurringTaskId: existing.id,
      });
    }

    const [updated] = await db
      .update(recurringAgentTasks)
      .set(patch)
      .where(
        and(
          eq(recurringAgentTasks.id, existing.id),
          eq(recurringAgentTasks.userId, user.id),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException();

    this.logger.log(
      { userId: user.id, recurringId: existing.id, scheduleChanged, paused: body.paused },
      'automation patched',
    );
    return { row: rowToDTO(updated) };
  }

  @Delete(':id')
  async tombstone(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    const existing = await loadOwn(user.id, id);
    await db
      .update(recurringAgentTasks)
      .set({
        tombstonedAt: new Date(),
        nextRunAt: null, // belt-and-suspenders; dispatcher already filters tombstoned
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(recurringAgentTasks.id, existing.id),
          eq(recurringAgentTasks.userId, user.id),
        ),
      );
    this.logger.log(
      { userId: user.id, recurringId: existing.id, kind: existing.kind },
      'automation tombstoned',
    );
    return { ok: true };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function loadOwn(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(recurringAgentTasks)
    .where(
      and(
        eq(recurringAgentTasks.id, id),
        eq(recurringAgentTasks.userId, userId),
        isNull(recurringAgentTasks.tombstonedAt),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException();
  return row;
}

async function resolveUserTimezone(userId: string): Promise<string> {
  const result = (await db.execute(sql`
    SELECT timezone FROM user_settings WHERE user_id = ${userId} LIMIT 1
  `)) as unknown as { rows?: Array<{ timezone: string | null }> };
  return result.rows?.[0]?.timezone ?? 'UTC';
}

async function resolveDefaultAgentId(userId: string): Promise<string | null> {
  // First agent the user owns. Default-Assistant seeding runs at
  // onboarding so this is almost always populated. The "default
  // agent" concept is implicit (no marker column today) — first
  // created wins. Tighten later if needed.
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.userId, userId))
    .orderBy(agents.createdAt)
    .limit(1);
  return row?.id ?? null;
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return code === '23505';
}

function rowToDTO(row: typeof recurringAgentTasks.$inferSelect): AutomationRowDTO {
  return {
    id: row.id,
    kind: row.kind,
    suggested_id: row.suggestedId,
    agent_id: row.agentId,
    days_of_week: row.daysOfWeek,
    times: row.times,
    timezone: row.timezone,
    jitter_minutes: row.jitterMinutes,
    payload: row.payload,
    trigger_mode: row.triggerMode,
    paused: row.paused,
    next_run_at: row.nextRunAt?.toISOString() ?? null,
    last_run_at: row.lastRunAt?.toISOString() ?? null,
    last_agent_task_id: row.lastAgentTaskId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
