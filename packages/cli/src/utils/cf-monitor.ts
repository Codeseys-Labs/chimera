/**
 * CloudFormation stack event monitoring utility.
 *
 * Polls DescribeStackEvents every N seconds, prints new events in chronological
 * order, and resolves when the stack reaches a terminal state. Used by both the
 * standalone `chimera monitor` command and the --monitor flag on deploy/destroy.
 */

import {
  CloudFormationClient,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ListStacksCommand,
  StackStatus,
  type StackEvent,
} from '@aws-sdk/client-cloudformation';
import { color } from '../lib/color.js';

/** All statuses that mean the stack operation has finished (success or failure). */
const TERMINAL_STATUSES = new Set([
  'CREATE_COMPLETE',
  'CREATE_FAILED',
  'UPDATE_COMPLETE',
  'UPDATE_FAILED',
  'DELETE_COMPLETE',
  'DELETE_FAILED',
  'ROLLBACK_COMPLETE',
  'ROLLBACK_FAILED',
  'UPDATE_ROLLBACK_COMPLETE',
  'UPDATE_ROLLBACK_FAILED',
  'IMPORT_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
  'IMPORT_ROLLBACK_FAILED',
]);

export type MonitorOutcome = 'complete' | 'failed' | 'not_found';

function formatEvent(event: StackEvent): string {
  const ts = event.Timestamp ? new Date(event.Timestamp).toLocaleTimeString() : '--:--:--';
  const resourceId = event.LogicalResourceId ?? 'unknown';
  const resourceType = event.ResourceType ? ` (${event.ResourceType})` : '';
  const status = event.ResourceStatus ?? '';
  const reason = event.ResourceStatusReason ? `\n    ${color.gray(event.ResourceStatusReason)}` : '';

  let formattedStatus: string;
  if (status.endsWith('_COMPLETE') && !status.includes('ROLLBACK')) {
    formattedStatus = color.green(status);
  } else if (status.includes('FAILED') || status.includes('ROLLBACK')) {
    formattedStatus = color.red(status);
  } else if (status.includes('IN_PROGRESS')) {
    formattedStatus = color.yellow(status);
  } else {
    formattedStatus = color.gray(status);
  }

  return `[${color.gray(ts)}] ${color.bold(resourceId)}${color.gray(resourceType)} ${formattedStatus}${reason}`;
}

/**
 * Monitor a CloudFormation stack until it reaches a terminal state.
 * Prints events as they arrive. Resolves with the final outcome.
 *
 * @param client         - CloudFormationClient to use
 * @param stackName      - Name of the stack to watch
 * @param pollIntervalMs - How often to poll for new events (default: 10 000 ms)
 * @param showHistory    - When false (default), skip events that existed before
 *                         monitoring started. Pass true to stream events from the
 *                         very beginning of the operation (e.g. deploy --monitor).
 */
export async function monitorStack(
  client: CloudFormationClient,
  stackName: string,
  pollIntervalMs = 10_000,
  showHistory = false,
): Promise<MonitorOutcome> {
  const seenEventIds = new Set<string>();

  if (!showHistory) {
    // Seed seen IDs from the current event page so we only print new events.
    try {
      const resp = await client.send(new DescribeStackEventsCommand({ StackName: stackName }));
      for (const event of resp.StackEvents ?? []) {
        if (event.EventId) seenEventIds.add(event.EventId);
      }
    } catch (error: any) {
      if (error.name === 'ValidationError') return 'not_found';
      throw error;
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Fetch events (newest-first), stop at the first event we've already seen.
    try {
      const eventsResp = await client.send(new DescribeStackEventsCommand({ StackName: stackName }));
      const newEvents: StackEvent[] = [];

      for (const event of eventsResp.StackEvents ?? []) {
        if (event.EventId && seenEventIds.has(event.EventId)) break;
        newEvents.push(event);
      }

      // Print in chronological order (reverse of newest-first).
      for (const event of [...newEvents].reverse()) {
        if (event.EventId) seenEventIds.add(event.EventId);
        console.log(formatEvent(event));
      }
    } catch (error: any) {
      if (error.name === 'ValidationError') return 'not_found';
      throw error;
    }

    // Check the current stack status to detect terminal state.
    let stackStatus: string;
    try {
      const descResp = await client.send(new DescribeStacksCommand({ StackName: stackName }));
      stackStatus = descResp.Stacks?.[0]?.StackStatus ?? 'UNKNOWN';
    } catch (error: any) {
      if (error.name === 'ValidationError') return 'not_found';
      throw error;
    }

    if (TERMINAL_STATUSES.has(stackStatus)) {
      // Success: terminal COMPLETE status that is NOT a rollback.
      const isSuccess = stackStatus.endsWith('_COMPLETE') && !stackStatus.includes('ROLLBACK');
      return isSuccess ? 'complete' : 'failed';
    }

    await new Promise<void>(resolve => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Find all Chimera stacks currently in an active (in-progress) state for the
 * given environment prefix (e.g. "Chimera-dev-").
 */
export async function findActiveStacks(
  client: CloudFormationClient,
  envPrefix: string,
): Promise<string[]> {
  const resp = await client.send(new ListStacksCommand({
    StackStatusFilter: [
      StackStatus.CREATE_IN_PROGRESS,
      StackStatus.UPDATE_IN_PROGRESS,
      StackStatus.DELETE_IN_PROGRESS,
      StackStatus.ROLLBACK_IN_PROGRESS,
      StackStatus.UPDATE_ROLLBACK_IN_PROGRESS,
      StackStatus.UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS,
    ],
  }));

  return (resp.StackSummaries ?? [])
    .filter(s => s.StackName?.startsWith(envPrefix))
    .map(s => s.StackName!);
}
