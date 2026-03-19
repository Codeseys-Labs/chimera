---
title: User-Through-Agent Collaboration
task: chimera-efac
status: complete
date: 2026-03-19
---

# User-Through-Agent Collaboration

## Overview

This document explores how **humans collaborate with each other through agents** as intermediaries, coordinators, or workspace facilitators. Unlike direct agent-to-agent or user-to-agent interaction, this pattern enables asynchronous, mediated human collaboration where AI agents act as intelligent proxies.

## Collaboration Modalities

### 1. User-Agent-User Mediation

**Pattern**: User A → Agent → User B → Agent → User A

Agents act as intelligent intermediaries that:
- **Transform requests**: User A asks agent to "schedule a meeting with Bob" → Agent interprets Bob's availability, proposes times
- **Contextualize messages**: Agent adds relevant context when routing messages between users
- **Resolve ambiguity**: Agent clarifies incomplete information before passing to next user
- **Maintain continuity**: Agent remembers conversation history across asynchronous turns

**Use Cases**:
- Cross-team task delegation where direct communication is inefficient
- Asynchronous decision-making with context preservation
- Multi-timezone collaboration with intelligent handoffs
- Expert consultation routing (agent finds right expert, frames question appropriately)

**Implementation Considerations**:
```typescript
interface MediatedMessage {
  from: UserId;
  to: UserId;
  originalMessage: string;
  agentContext: {
    interpretation: string;
    suggestedActions: Action[];
    relevantHistory: ConversationTurn[];
  };
  routingMetadata: {
    urgency: "high" | "medium" | "low";
    requiresResponse: boolean;
    deadline?: ISO8601Timestamp;
  };
}
```

**Challenges**:
- **Trust boundary**: Users must trust agent's interpretation and context addition
- **Attribution**: Distinguishing agent additions from user intent
- **Consent**: When can agent speak "on behalf of" a user?
- **Privacy**: What context should agent share vs. withhold?

### 2. Shared Workspace Collaboration

**Pattern**: Multiple users interact with the same workspace through their respective agents

Agents provide:
- **Personalized views**: Each user's agent filters/organizes shared content for their context
- **Conflict resolution**: When users make competing changes, agents negotiate or escalate
- **Awareness**: Agents notify users of relevant activity by others
- **Contribution synthesis**: Agents combine multiple user inputs into coherent artifacts

**Use Cases**:
- Collaborative document editing (each user works through their agent)
- Shared codebase development (agents coordinate commits, reviews)
- Project planning (multiple agents contribute to shared roadmap)
- Knowledge base curation (agents help users contribute and discover content)

**Architecture**:
```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   User A    │         │   User B    │         │   User C    │
└──────┬──────┘         └──────┬──────┘         └──────┬──────┘
       │                       │                       │
┌──────▼──────┐         ┌──────▼──────┐         ┌──────▼──────┐
│  Agent A    │         │  Agent B    │         │  Agent C    │
│ (A's context)│        │ (B's context)│        │ (C's context)│
└──────┬──────┘         └──────┬──────┘         └──────┬──────┘
       │                       │                       │
       └───────────┬───────────┴───────────┬───────────┘
                   │                       │
            ┌──────▼───────────────────────▼──────┐
            │     Shared Workspace State          │
            │  ┌────────────────────────────────┐ │
            │  │  Documents, Code, Data         │ │
            │  │  + Operational Transform Log   │ │
            │  │  + Permission/Access Rules     │ │
            │  └────────────────────────────────┘ │
            └─────────────────────────────────────┘
```

**Key Patterns**:

**Operational Transform with Agent Mediation**:
```typescript
interface WorkspaceOperation {
  userId: string;
  agentId: string;
  operation: {
    type: "insert" | "delete" | "modify";
    path: string;
    content: any;
    vectorClock: VectorClock;
  };
  agentInterpretation: {
    intent: string; // What user was trying to do
    conflicts: ConflictDetection[];
    suggestions: string[];
  };
}

// Agents apply OT locally, then sync
async function applyOperation(op: WorkspaceOperation) {
  const transformed = await agent.transformWithContext(op);
  await workspace.apply(transformed);
  await notifyOtherAgents(transformed);
}
```

**Awareness & Presence**:
```typescript
interface AgentPresence {
  userId: string;
  agentId: string;
  activeAreas: string[]; // Which parts of workspace
  currentActivity: {
    type: "reading" | "editing" | "analyzing" | "idle";
    target: string;
    startedAt: timestamp;
  };
  availability: "available" | "busy" | "away";
}

// Agents broadcast presence, filter notifications
agent.on("workspaceChange", (change, presenceInfo) => {
  if (agent.shouldNotifyUser(change, presenceInfo)) {
    user.notify(agent.summarizeChange(change));
  }
});
```

### 3. Agent as Coordinator

**Pattern**: Agent orchestrates multi-user workflow without direct user-to-user contact

Agent responsibilities:
- **Task decomposition**: Breaks user request into sub-tasks for multiple users
- **Assignment**: Routes tasks to appropriate users based on expertise, availability
- **Progress tracking**: Aggregates status from multiple users' agents
- **Dependency management**: Ensures prerequisites are met before assigning next tasks
- **Synthesis**: Combines outputs from multiple users into final deliverable

**Use Cases**:
- Complex project execution (design → implementation → review → deployment)
- Multi-stakeholder approvals (agent routes through approval chain)
- Crowd-sourced problem-solving (agent distributes sub-problems, combines solutions)
- Event planning (agent coordinates contributions from multiple parties)

**Workflow Example**:
```typescript
interface CoordinatedWorkflow {
  goal: string;
  coordinator: AgentId;
  stages: WorkflowStage[];
}

interface WorkflowStage {
  id: string;
  description: string;
  assignedUsers: UserId[];
  dependencies: string[]; // stage IDs
  status: "pending" | "in_progress" | "blocked" | "complete";
  artifacts: Artifact[];
}

// Coordinator agent logic
class CoordinatorAgent {
  async executeWorkflow(workflow: CoordinatedWorkflow) {
    for (const stage of workflow.stages) {
      await this.waitForDependencies(stage.dependencies);

      // Dispatch to user agents
      const userAgents = await this.getUserAgents(stage.assignedUsers);
      const tasks = await this.decomposeStage(stage);

      const results = await Promise.all(
        tasks.map((task, i) =>
          userAgents[i].execute(task)
        )
      );

      stage.artifacts = await this.synthesizeResults(results);
      stage.status = "complete";
    }
  }
}
```

**Coordination Primitives**:
- **Task queues**: Agent maintains per-user task queue
- **Notification routing**: Agent determines when/how to notify users
- **Context bundling**: Agent packages relevant context with each task
- **Feedback loops**: Agent solicits user feedback to refine coordination

## Multi-User Session Patterns

### Turn-Taking with Agent Memory

**Scenario**: Users A and B work on same problem, but not simultaneously

```typescript
interface TurnBasedSession {
  sessionId: string;
  participants: UserId[];
  sharedContext: SessionContext;
  turnHistory: Turn[];
  currentTurn: UserId | null;
}

interface Turn {
  userId: string;
  agentId: string;
  timestamp: ISO8601Timestamp;
  actions: Action[];
  agentSummary: string; // What agent learned from this turn
  nextUserContext: string; // What next user should know
}

// Agent persists context across turns
class SessionAgent {
  async handleTurn(userId: UserId, actions: Action[]) {
    const context = await this.loadSharedContext();
    const results = await this.executeActions(actions, context);

    // Update shared context
    await this.updateContext({
      lastTurn: { userId, actions, results },
      summary: await this.summarizeTurn(results),
      nextSteps: await this.suggestNextSteps(results)
    });

    // Notify next participant
    await this.notifyNextUser(this.determineNextUser());
  }
}
```

### Parallel Contribution with Merge

**Scenario**: Users work simultaneously, agents merge contributions

```typescript
interface ParallelSession {
  sessionId: string;
  participants: Map<UserId, AgentId>;
  baseState: WorkspaceState;
  userBranches: Map<UserId, BranchState>;
  mergeStrategy: "agent-auto" | "agent-propose" | "manual";
}

// Each user's agent works on a branch
class ParallelAgent {
  async contributeToSession(userActions: Action[]) {
    const branch = await this.getBranch(this.userId);
    await this.applyActions(branch, userActions);

    // Attempt merge
    const mainState = await this.getMainState();
    const mergeResult = await this.attemptMerge(branch, mainState);

    if (mergeResult.conflicts.length > 0) {
      // Coordinate with other agents to resolve
      const resolution = await this.coordinateMerge(mergeResult.conflicts);
      await this.applyResolution(resolution);
    }
  }
}
```

### Real-Time Collaborative Sessions

**Scenario**: Multiple users + agents in live session (e.g., pair programming through agents)

```typescript
interface LiveSession {
  sessionId: string;
  participants: LiveParticipant[];
  liveState: LiveWorkspaceState;
  eventStream: EventStream;
}

interface LiveParticipant {
  userId: string;
  agentId: string;
  cursor: CursorPosition;
  focus: FocusArea;
  recentActions: Action[];
}

// Agents sync in real-time via WebSocket or similar
class LiveCollaborationAgent {
  constructor(private eventStream: EventStream) {
    this.eventStream.on("userAction", this.handleRemoteAction);
  }

  async handleLocalAction(action: Action) {
    // Apply optimistically
    await this.applyLocally(action);

    // Broadcast to other agents
    await this.eventStream.publish({
      type: "user_action",
      userId: this.userId,
      agentId: this.agentId,
      action: action,
      timestamp: Date.now()
    });

    // Agent adds intelligent annotations
    const context = await this.analyzeAction(action);
    await this.shareContext(context);
  }

  async handleRemoteAction(event: UserActionEvent) {
    if (event.agentId !== this.agentId) {
      await this.applyRemoteAction(event.action);

      // Notify user if relevant
      if (this.affectsUserWork(event.action)) {
        await this.notifyUser({
          type: "collaborator_action",
          user: event.userId,
          summary: await this.summarizeAction(event.action)
        });
      }
    }
  }
}
```

## Permission & Access Control

### Agent-Mediated Permissions

Agents enforce and interpret permissions on behalf of users:

```typescript
interface PermissionPolicy {
  resource: string;
  rules: PermissionRule[];
}

interface PermissionRule {
  principal: UserId | "any_authenticated" | "public";
  actions: string[];
  conditions: Condition[];
  agentBehavior: {
    onDenied: "block" | "request" | "suggest_alternative";
    onGranted: "execute" | "confirm_first";
  };
}

class PermissionAgent {
  async checkPermission(
    userId: UserId,
    resource: string,
    action: string
  ): Promise<PermissionResult> {
    const policy = await this.getPolicy(resource);
    const result = this.evaluateRules(policy, userId, action);

    if (!result.granted) {
      // Agent can request permission on behalf of user
      if (policy.agentBehavior.onDenied === "request") {
        return await this.requestPermission(userId, resource, action);
      }

      // Or suggest alternative actions
      if (policy.agentBehavior.onDenied === "suggest_alternative") {
        result.alternatives = await this.findAlternatives(resource, action);
      }
    }

    return result;
  }
}
```

### Delegation & Proxy Authority

Users can delegate authority to agents:

```typescript
interface Delegation {
  from: UserId;
  toAgent: AgentId;
  scope: PermissionScope;
  constraints: DelegationConstraint[];
  expiration: ISO8601Timestamp;
}

interface DelegationConstraint {
  type: "require_confirmation" | "max_impact" | "audit_log";
  parameters: Record<string, any>;
}

// Agent acts on behalf of user within delegation bounds
class DelegatedAgent {
  async actOnBehalfOf(user: UserId, action: Action) {
    const delegation = await this.getDelegation(user, this.agentId);

    if (!this.withinScope(action, delegation.scope)) {
      throw new Error("Action exceeds delegation scope");
    }

    // Check constraints
    for (const constraint of delegation.constraints) {
      if (constraint.type === "require_confirmation") {
        const confirmed = await this.requestConfirmation(user, action);
        if (!confirmed) return;
      }
    }

    await this.executeAction(action, { actingFor: user });
    await this.logDelegatedAction(user, action);
  }
}
```

## Communication Patterns

### Notification Routing

Agents intelligently filter and route notifications:

```typescript
interface NotificationPolicy {
  userId: string;
  rules: NotificationRule[];
  agentPreferences: {
    batchUpdates: boolean;
    summarizeThread: boolean;
    prioritize: "urgency" | "relevance" | "sender";
  };
}

class NotificationAgent {
  async handleIncomingMessage(msg: Message, fromUser: UserId) {
    const policy = await this.getPolicy(this.userId);

    // Agent evaluates urgency
    const urgency = await this.assessUrgency(msg, fromUser);

    // Agent evaluates relevance
    const relevance = await this.assessRelevance(msg, this.userContext);

    // Decide notification method
    const method = this.selectNotificationMethod(urgency, relevance, policy);

    if (method === "immediate") {
      await this.notifyUser(msg);
    } else if (method === "batch") {
      await this.addToBatch(msg);
    } else if (method === "suppress") {
      await this.logSuppressed(msg, "low_relevance");
    }
  }

  async sendBatchNotification() {
    const batch = await this.getBatchedMessages();
    const summary = await this.summarizeBatch(batch);
    await this.notifyUser(summary);
  }
}
```

### Message Threading & Context

Agents maintain conversation threads:

```typescript
interface ConversationThread {
  threadId: string;
  participants: UserId[];
  rootMessage: MessageId;
  messages: Message[];
  agentSummary: {
    topic: string;
    keyPoints: string[];
    openQuestions: string[];
    decisions: Decision[];
  };
}

class ThreadAgent {
  async addMessageToThread(msg: Message, threadId: string) {
    const thread = await this.getThread(threadId);

    // Agent analyzes message in thread context
    const analysis = await this.analyzeMessage(msg, thread);

    // Update thread summary
    thread.agentSummary = await this.updateSummary(
      thread.agentSummary,
      analysis
    );

    // Determine if other participants should be notified
    const relevantParticipants = this.findRelevantParticipants(
      analysis,
      thread.participants
    );

    for (const participant of relevantParticipants) {
      await this.notifyParticipant(participant, {
        thread: threadId,
        summary: analysis.summary,
        urgency: analysis.urgency
      });
    }
  }
}
```

## Conflict Resolution

### Agent-Mediated Negotiation

When users have conflicting goals/actions:

```typescript
interface Conflict {
  type: "resource_contention" | "incompatible_changes" | "policy_violation";
  parties: UserId[];
  description: string;
  proposedResolutions: Resolution[];
}

interface Resolution {
  strategy: "merge" | "prioritize" | "escalate" | "compromise";
  outcome: any;
  affectedParties: UserId[];
  reasoning: string;
}

class ConflictResolutionAgent {
  async resolveConflict(conflict: Conflict): Promise<Resolution> {
    // Agents negotiate on behalf of users
    const userAgents = await this.getUserAgents(conflict.parties);

    // Each agent proposes resolution from their user's perspective
    const proposals = await Promise.all(
      userAgents.map(agent => agent.proposeResolution(conflict))
    );

    // Find common ground
    const consensus = await this.findConsensus(proposals);

    if (consensus) {
      return {
        strategy: "merge",
        outcome: consensus,
        affectedParties: conflict.parties,
        reasoning: "Agents reached consensus"
      };
    }

    // Try compromise
    const compromise = await this.negotiateCompromise(proposals);

    if (compromise) {
      return {
        strategy: "compromise",
        outcome: compromise,
        affectedParties: conflict.parties,
        reasoning: "Agents negotiated compromise"
      };
    }

    // Escalate to users
    return {
      strategy: "escalate",
      outcome: null,
      affectedParties: conflict.parties,
      reasoning: "Agents could not resolve automatically"
    };
  }
}
```

## Privacy & Trust

### Context Sharing Boundaries

Agents must respect privacy when mediating between users:

```typescript
interface ContextSharingPolicy {
  userId: string;
  rules: SharingRule[];
}

interface SharingRule {
  dataCategory: "personal_info" | "work_history" | "preferences" | "private_notes";
  shareWith: "no_one" | "team" | "specific_users" | "any_authenticated";
  agentBehavior: {
    redact: boolean;
    summarizeInstead: boolean;
    requireConsent: boolean;
  };
}

class PrivacyAgent {
  async prepareContextForSharing(
    context: UserContext,
    recipient: UserId
  ): Promise<SharedContext> {
    const policy = await this.getPolicy(this.userId);
    const sharedContext: SharedContext = {};

    for (const [key, value] of Object.entries(context)) {
      const category = this.categorizeData(key, value);
      const rule = policy.rules.find(r => r.dataCategory === category);

      if (this.canShare(rule, recipient)) {
        if (rule.agentBehavior.redact) {
          sharedContext[key] = this.redactSensitive(value);
        } else if (rule.agentBehavior.summarizeInstead) {
          sharedContext[key] = await this.summarize(value);
        } else {
          sharedContext[key] = value;
        }
      }
    }

    return sharedContext;
  }
}
```

## Implementation Technologies

### AWS Services for User-Through-Agent Collaboration

**Amazon EventBridge**: Cross-agent event routing
```typescript
// User A's agent publishes event
await eventBridge.putEvents({
  Entries: [{
    Source: "user-agent.user-a",
    DetailType: "collaboration.request",
    Detail: JSON.stringify({
      targetUser: "user-b",
      requestType: "review",
      artifact: "s3://workspace/doc.md",
      context: "User A needs feedback on proposal"
    })
  }]
});

// User B's agent subscribes to events
const rule = await eventBridge.putRule({
  Name: "user-b-collaboration-requests",
  EventPattern: JSON.stringify({
    "source": ["user-agent.user-a"],
    "detail-type": ["collaboration.request"],
    "detail": {
      "targetUser": ["user-b"]
    }
  })
});
```

**Amazon SQS**: Task queues for asynchronous coordination
```typescript
// Coordinator agent queues tasks for users
await sqs.sendMessage({
  QueueUrl: userBTaskQueue,
  MessageBody: JSON.stringify({
    task: "review_code",
    assignedBy: "user-a",
    deadline: "2026-03-20T17:00:00Z",
    context: {
      repo: "chimera",
      pr: "123",
      agentSummary: "Critical security fix, needs quick review"
    }
  }),
  MessageAttributes: {
    priority: { DataType: "String", StringValue: "high" },
    category: { DataType: "String", StringValue: "code_review" }
  }
});
```

**Amazon DynamoDB**: Shared workspace state
```typescript
// Agents use DynamoDB for shared state with optimistic locking
const params = {
  TableName: "SharedWorkspaces",
  Key: { workspaceId: "ws-123" },
  UpdateExpression: "SET document = :doc, version = version + :inc",
  ConditionExpression: "version = :currentVersion",
  ExpressionAttributeValues: {
    ":doc": newDocument,
    ":inc": 1,
    ":currentVersion": currentVersion
  }
};

try {
  await dynamodb.update(params);
} catch (err) {
  if (err.code === "ConditionalCheckFailedException") {
    // Version conflict, agent must merge
    const latest = await dynamodb.getItem({
      TableName: "SharedWorkspaces",
      Key: { workspaceId: "ws-123" }
    });
    const merged = await agent.mergeDocuments(newDocument, latest.document);
    // Retry with new version
  }
}
```

**Amazon SNS**: Notification fan-out
```typescript
// Agent publishes update to topic, all interested agents receive
await sns.publish({
  TopicArn: "arn:aws:sns:us-east-1:123456789012:workspace-updates",
  Message: JSON.stringify({
    workspaceId: "ws-123",
    updateType: "document_modified",
    modifiedBy: "user-a-agent",
    summary: "Updated section 3 with new architecture diagram",
    affectedSections: ["architecture.overview"]
  }),
  MessageAttributes: {
    workspaceId: { DataType: "String", StringValue: "ws-123" },
    updateType: { DataType: "String", StringValue: "document_modified" }
  }
});

// Other agents filter by attributes
```

**AWS AppSync**: Real-time GraphQL subscriptions
```typescript
// Real-time collaboration via GraphQL subscriptions
subscription OnWorkspaceChange($workspaceId: ID!) {
  workspaceChanged(workspaceId: $workspaceId) {
    operation {
      type
      path
      userId
      agentId
      content
    }
    timestamp
    vectorClock
  }
}

// Agent subscribes and applies operations
client.subscribe({ query: OnWorkspaceChangeSubscription })
  .subscribe({
    next: async (event) => {
      await agent.applyRemoteOperation(event.data.workspaceChanged);
      await agent.notifyUserIfRelevant(event);
    }
  });
```

## Comparison: OpenClaw Lane Queue vs Overstory Swarm

### OpenClaw Lane Queue Model

**Characteristics**:
- Linear task pipeline: Tasks flow through sequential "lanes"
- Each lane has specialized agents
- Work items move from lane to lane as they progress
- User interaction at lane boundaries (approval gates)

**User-through-agent collaboration**:
```
User A → Lane 1 (Design) → Gate → User B → Lane 2 (Implement) → Gate → User A
```
- Users collaborate by approving/modifying work as it passes through gates
- Agents in each lane execute specialized tasks
- Collaboration is **sequential and gate-driven**

**Strengths**:
- Clear workflow stages
- Explicit approval points
- Easy to audit (work item trail)

**Limitations**:
- Limited parallelism (work flows linearly)
- Users must wait for previous stages to complete
- Less flexible for ad-hoc collaboration

### Overstory Swarm/Graph Model

**Characteristics**:
- Graph-based task decomposition
- Agents can spawn sub-agents dynamically
- Multiple users can engage with different parts of the graph simultaneously
- Flexible coordination patterns (fan-out, gather, pipeline, etc.)

**User-through-agent collaboration**:
```
         ┌─ Agent A1 ─┐
User A ──┤            ├─→ merge ──→ User C
         └─ Agent A2 ─┘
               ∧
               │
         ┌─ Agent B1 ─┐
User B ──┤            │
         └─ Agent B2 ─┘
```
- Users collaborate through agents working on interdependent tasks
- Agents coordinate in graph structure (not linear pipeline)
- Collaboration is **parallel and graph-driven**

**Strengths**:
- High parallelism (multiple users work simultaneously)
- Flexible coordination (agents adapt graph dynamically)
- Better for complex, non-linear workflows

**Limitations**:
- More complex to reason about
- Requires sophisticated conflict resolution
- Harder to visualize overall progress

**Hybrid Approach for Chimera**:
- Use **Lane Queue** for well-defined workflows (e.g., PR review: draft → review → approve → merge)
- Use **Swarm/Graph** for exploratory/research work (e.g., multi-user architecture brainstorming)
- Allow **agents to switch between modes** based on task structure

## Best Practices

1. **Explicit Agent Boundaries**: Make clear when agent is speaking vs. user
2. **Context Preservation**: Agents must maintain continuity across async turns
3. **Privacy-First**: Default to not sharing user context, require explicit policy
4. **Conflict Escalation**: Agents should escalate to users when auto-resolution fails
5. **Audit Trails**: Log all agent-mediated actions for transparency
6. **Graceful Degradation**: System should work without agents (fall back to direct user-to-user)
7. **User Overrides**: Users can always bypass or correct agent behavior
8. **Feedback Loops**: Agents learn from user corrections to improve mediation

## Open Questions

1. **Attribution**: How to clearly show which parts of output came from user vs. agent?
2. **Liability**: Who is responsible when agent misrepresents user intent?
3. **Learning from Collaboration**: Can agents learn user collaboration patterns and preferences?
4. **Cross-Tenant Collaboration**: How do agents from different tenants collaborate while respecting isolation?
5. **Agent Consensus**: When agents disagree on resolution, how to break tie?
6. **Performance**: What are latency implications of agent-mediated collaboration vs. direct?

## Related Research

- **Agent Communication Languages (ACL)**: FIPA-ACL, KQML for structured agent communication
- **Multi-Agent Coordination**: TAEMS framework, BDI (Belief-Desire-Intention) architectures
- **Operational Transformation**: Algorithm for real-time collaborative editing (Google Docs)
- **CSCW (Computer-Supported Cooperative Work)**: Research on human collaboration tools
- **Shared Mental Models**: How teams develop shared understanding

## References

- [Agent-to-Agent Protocol Documentation](./05-Agent-to-Agent-Protocol.md)
- [AWS Messaging Services Comparison](./02-AWS-Messaging-Services.md)
- [Shared Memory & State Patterns](./03-Shared-Memory-and-State.md)
- [Real-Time Streaming](./04-Real-Time-Streaming.md)
