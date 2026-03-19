# Cost Analysis

> Parent: [[Index]]
> Source: Builder article by @jiade (honest numbers including hidden costs)

## Scenario A: Solo Developer, Personal Use

| Cost Item | Mac Mini | AgentCore |
|-----------|---------|-----------|
| Hardware | $599 (amortized $200/yr) | $0 |
| Electricity | $30/yr | $0 |
| API fees (Claude Sonnet) | ~$600/yr | ~$60/yr (Nova Lite) |
| EC2 Gateway | -- | ~$420/yr (t4g.small) |
| AgentCore Runtime | -- | ~$60/yr (light use) |
| Setup time (3hrs @ $100/hr) | $300 | $150 (1.5hrs) |
| Monthly maintenance (1hr) | $1,200/yr | ~$0 |
| **Year 1 total** | **~$2,930** | **~$690** |

Mac Mini looks cheaper on paper until you count your own time.

## Scenario B: Team of 10, Shared Agent

| Cost Item | Mac Mini | AgentCore |
|-----------|---------|-----------|
| Hardware | $599 | $0 |
| API fees (10 users, mixed models) | ~$2,500/mo | ~$540/mo |
| EC2 Gateway | -- | $35/mo |
| AgentCore Runtime | -- | $50/mo |
| Security setup + ongoing | $3,000/yr (est.) | $0 |
| Incident response (1 breach) | $5,000+ (est.) | $0 |
| **Year 1 total** | **~$38,000** | **~$8,700** |

API fee difference alone: $23,520/year. Model routing (80% Nova / 20% Sonnet)
is the biggest cost lever.

## Scenario C: Family of 4

| Cost Item | Mac Mini | AgentCore |
|-----------|---------|-----------|
| Hardware | $599 | $0 |
| API fees (4 users, light use) | ~$100/mo | ~$20/mo |
| EC2 Gateway | -- | $12/mo (t4g.small) |
| AgentCore Runtime | -- | $10/mo |
| Permission isolation | Not possible | Built-in |
| **Monthly ongoing** | **~$108** | **~$42** |

Cost difference is modest. The real difference is the permission model.

## Model Cost Breakdown (Team of 10, 50 conversations/day each)

| Strategy | Model | Daily | Monthly |
|----------|-------|-------|---------|
| All Claude Sonnet | Sonnet 4.5 | ~$83 | ~$2,500 |
| All Nova Lite | Nova 2 Lite | ~$1.67 | ~$50 |
| Smart routing (80% Nova, 20% Sonnet) | Mixed | ~$18 | ~$540 |
| **Recommended** | **Mixed** | **~$18** | **~$540** |

Smart routing: Nova Lite for routine tasks, Sonnet for complex reasoning.
90% of quality at 22% of all-Sonnet cost.

## AgentCore Pay-Per-Use Economics

Agent sessions have a bursty utilization pattern:
- Active CPU: ~18 seconds per 60-second window
- Waiting (LLM response, tool execution, APIs): ~42 seconds

Traditional compute charges for all 60 seconds.
AgentCore charges for 18 seconds.

For OpenClaw heartbeats (scheduled tasks): 10 seconds of work → pay for 10 seconds.
Not 24 hours of Mac Mini uptime.

## Hidden Costs People Forget

### Mac Mini / Self-Hosted
- Your time for setup (3+ hours)
- Your time for maintenance (1+ hour/month)
- Security hardening (or the cost of not doing it)
- Downtime when the machine crashes at 2 AM
- Electricity + internet for 24/7 uptime
- No multi-user isolation = risk of cross-user data leaks

### AgentCore
- EC2 Gateway runs 24/7 (~$12-35/mo depending on size)
- Bedrock model access must be enabled in the console (no cost, just approval)
- CloudFormation stack management (minimal, mostly automated)

## Graviton ARM Savings

AWS Graviton instances cost 20-40% less than equivalent x86:

| Instance | Type | Monthly | Use Case |
|----------|------|---------|----------|
| t4g.small | Graviton | ~$12 | Family gateway |
| c7g.large | Graviton | ~$35 | Team gateway |
| c5.large | x86 | ~$50 | Same specs, 30% more |

For a 24/7 gateway, Graviton saves ~$180/year vs equivalent x86.
