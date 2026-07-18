# CRM feature map — where emcp stands vs. the market

_Last updated: 2026-07-06_

This document maps what emcp has today against the feature set of established
CRMs (Attio, HubSpot, Pipedrive, Close, folk, Twenty), so gaps are explicit
decisions instead of blind spots. Legend:

- **Yes** — implemented and usable today
- **Partial** — exists but with caveats (noted)
- **No** — not built; the "Plan" column says whether/when we intend to

Reference set: Attio (data-model-first, modern), HubSpot (full marketing
suite), Pipedrive (SMB pipeline), Close (calling/outbound), folk (lightweight
relationship), Twenty (open-source CRM).

## 1. Data model & records

| Feature                      | emcp                                                              | Typical CRM                     | Plan                                                          |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------- |
| Companies                    | Yes                                                               | Yes                             | —                                                             |
| People (contacts)            | Yes                                                               | Yes                             | —                                                             |
| Leads as first-class records | Yes (engagements)                                                 | Varies (HubSpot/Pipedrive: yes) | —                                                             |
| Deals / opportunities        | Yes                                                               | Yes                             | —                                                             |
| Products / offerings         | Yes (offerings + record links)                                    | Yes (products, line items)      | Line items + amounts per deal: 0.3                            |
| Custom fields                | Yes (text, number, date, select, url, checkbox; per entity)       | Yes                             | —                                                             |
| Custom objects               | No                                                                | Attio/HubSpot: yes              | Not planned for 0.x; custom fields + tags cover the 90% case  |
| Tags / labels                | Yes (cross-entity, colored)                                       | Yes                             | —                                                             |
| Record relationships         | Partial (company↔person links, deal stakeholders, offering links) | Attio: arbitrary relations      | Arbitrary relations not planned; named links cover CRM basics |
| Files & attachments          | No                                                                | Yes                             | 0.3 — attachment port + local disk/S3 impl                    |
| Notes on records             | Yes (activities of kind `note`)                                   | Yes                             | —                                                             |

## 2. Contact organization ← *the gap you noticed*

Your observation ("my contacts are mixed and not tagged to any type") was
the biggest practical gap in daily use. **Shipped in 0.5 as Contact lists**:

| Feature                                                                 | emcp                                                                                                                                   | Typical CRM                          | Plan                                                                      |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| Contact types / audiences (job search, product X, consulting…)          | **Yes (0.5)** — Contact lists: named, colored audiences over people + companies; filters on index views, bulk assign, dashboard card, `list_*` MCP tools | folk/Attio: first-class groups/lists | Done — consider per-list default owner/pipeline later                     |
| Duplicate detection                                                     | No (import upserts by external ref only)                                                                                               | Yes (email/domain match)             | **0.2 (P0)** — dedupe report + merge operation                            |
| Record merge                                                            | No                                                                                                                                     | Yes                                  | 0.2, ships with dedupe                                                    |
| Segments / smart lists                                                  | Partial (saved views = filter presets; lists = static membership)                                                                      | Yes (dynamic lists)                  | Saved views cover dynamic segments; lists cover curated ones              |
| Enrichment (logo, size, socials from domain/email)                      | No                                                                                                                                     | Attio/HubSpot: yes                   | 0.3+, optional — needs external API, off by default for self-host privacy |
| Org hierarchies (parent/child companies)                                | No                                                                                                                                     | Enterprise CRMs: yes                 | Not planned for 0.x                                                       |

**How to use lists for the "mixed contacts" problem:** create one list per
audience (e.g. `Job search`, `Product X prospects`, `Consulting clients`)
from the **Lists** page in the sidebar (your segments also nest right under
it). Add members three ways: search-and-add on the list's own page, the
quick "+" on any People/Companies row (membership chips live in the table),
or bulk-select rows → *List*. Filter any view by list; the dashboard card
links each segment. Agents do the same triage over MCP (`list_create`,
`list_add_members`, filtered `person_list`).

**Still recommended (0.2):**

1. **Dedupe pass**: `person.findDuplicates` (same email, or same
   name+company) surfaced as an admin report, plus `person.merge` (keeps
   activities, links, custom fields; audit-logged; agent-callable with
   approval).
2. **Import prompt**: CSV import maps a "list" column so imported contacts
   land in an audience instead of unclassified.

## 3. Pipeline & deals

| Feature                                 | emcp                                            | Typical CRM              | Plan                                                        |
| --------------------------------------- | ----------------------------------------------- | ------------------------ | ----------------------------------------------------------- |
| Multiple pipelines                      | Yes (per entity type, default pipeline)         | Yes                      | —                                                           |
| Custom stages (reorder, rename, colors) | Yes                                             | Yes                      | —                                                           |
| Kanban board                            | Yes (leads + deals)                             | Yes                      | —                                                           |
| Win/loss with reasons                   | Yes (`deal.markWon` / `deal.markLost` + reason) | Yes                      | —                                                           |
| Deal value + currency                   | Yes (per-deal currency)                         | Yes                      | —                                                           |
| Weighted pipeline / stage probability   | No                                              | Pipedrive/HubSpot: yes   | 0.3 — probability per stage, weighted forecast              |
| Forecasting                             | No                                              | Yes (paid tiers usually) | 0.3+                                                        |
| Rotting / stale-deal alerts             | No                                              | Pipedrive: yes           | 0.2 — "no activity in N days" surfaced on home + saved view |
| Quotes / invoices                       | No                                              | Some (paid)              | Not planned; out of scope for a CRM core                    |

## 4. Activities, tasks & calendar

| Feature                           | emcp                                                                      | Typical CRM        | Plan                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| Activity timeline per record      | Yes (notes, calls, meetings, emails-as-log, stage changes, system events) | Yes                | —                                                                                              |
| Tasks with due dates & assignee   | Yes                                                                       | Yes                | —                                                                                              |
| Task complete/reopen              | Yes                                                                       | Yes                | —                                                                                              |
| Reminders / notifications         | No (tasks are pull, not push)                                             | Yes                | 0.2 (P1) — due-today digest via email once mailer lands; agent can already query overdue tasks |
| Calendar sync (Google/Outlook)    | No                                                                        | Yes                | 0.4+, cloud-first feature                                                                      |
| Meeting scheduler (booking links) | No                                                                        | HubSpot/Close: yes | Not planned; integrate, don't build                                                            |

## 5. Email & communication

emcp deliberately does **not** try to be an email client. The agent-native
answer is different: your agent drafts/sends via its own tools and **logs the
touch into the CRM through MCP**. Still, parity gaps worth naming:

| Feature                                        | emcp                                         | Typical CRM            | Plan                                                                 |
| ---------------------------------------------- | -------------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| Log an email/call/meeting against a record     | Yes (`activity.log`, agent-callable)         | Yes                    | —                                                                    |
| Two-way email sync (Gmail/Outlook)             | No                                           | Yes                    | Not in 0.x. Revisit for cloud; heavy OAuth + storage burden          |
| BCC-to-CRM address                             | No                                           | Yes                    | 0.3 (P1) — cheap once inbound mail lands; great low-friction capture |
| Templates & sequences                          | No                                           | Close/HubSpot: yes     | Not planned; agents replace canned sequences                         |
| Calling / SMS                                  | No                                           | Close: yes             | Not planned                                                          |
| Transactional email (invites, resets, digests) | No — invites print a one-time password in-UI | n/a (product plumbing) | **0.2 (P0)** — mailer port + SMTP/Resend impl; see `PRODUCTION.md`   |

## 6. Automation & agents

| Feature                              | emcp                                                                     | Typical CRM              | Plan                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------- |
| Workflow builder (if-this-then-that) | No                                                                       | HubSpot/Pipedrive: yes   | Not planned as click-ops. The operation catalog is the automation surface; agents compose it |
| **Agent access (MCP)**               | **Yes — first-class: 100+ typed operations, resources, context bundles** | No one has this natively | Our moat; keep widening                                                                      |
| **Approval workflow for risky ops**  | **Yes — trust profiles, pending actions, approve/reject UI**             | No equivalent            | —                                                                                            |
| **Full audit trail**                 | **Yes — every op, human or agent, with actor + before/after**            | Partial in most          | —                                                                                            |
| Webhooks (outbound)                  | No                                                                       | Yes                      | 0.3 (P1) — `webhook.subscribe` + delivery worker; unlocks Zapier/n8n                         |
| Public REST API                      | Yes (`POST /api/ops/:name`, bearer tokens)                               | Yes                      | Document + version it (0.2)                                                                  |
| Zapier/Make integration              | No                                                                       | Yes                      | Via webhooks + API once 0.3 lands                                                            |

## 7. Reporting & insights

| Feature                                           | emcp                                     | Typical CRM        | Plan                                                                                                            |
| ------------------------------------------------- | ---------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Home dashboard (pipeline snapshot, tasks, recent) | Yes                                      | Yes                | —                                                                                                               |
| Entity stats (by stage, by owner)                 | Yes (`stats.engagements`, `stats.deals`) | Yes                | —                                                                                                               |
| Custom reports / chart builder                    | No                                       | Yes (usually paid) | 0.3+ — but note: an agent with `stats.*` + `export.csv` already answers ad-hoc questions a report builder can't |
| Activity leaderboards                             | No                                       | Close: yes         | Not planned (single-team focus)                                                                                 |
| Export CSV                                        | Yes                                      | Yes                | —                                                                                                               |

## 8. Views & productivity

| Feature                                            | emcp                                       | Typical CRM       | Plan                           |
| -------------------------------------------------- | ------------------------------------------ | ----------------- | ------------------------------ |
| List views with server-side filter/sort/pagination | Yes                                        | Yes               | —                              |
| Saved views                                        | Yes (shared, per entity)                   | Yes               | —                              |
| Global search                                      | Yes (cross-entity)                         | Yes               | —                              |
| Command palette                                    | Yes (⌘K)                                   | Attio/Twenty: yes | —                              |
| Bulk actions (tag, stage, owner, archive)          | Yes                                        | Yes               | —                              |
| CSV import with preview & mapping                  | Yes                                        | Yes               | Label mapping in 0.2 (see §2)  |
| Keyboard-first UX                                  | Partial (palette + shortcuts)              | Attio: strong     | Continuous polish              |
| Mobile app / responsive                            | Partial (responsive layout, no native app) | Yes               | Native app not planned for 0.x |

## 9. Collaboration & administration

| Feature                                    | emcp                                              | Typical CRM                  | Plan                                         |
| ------------------------------------------ | ------------------------------------------------- | ---------------------------- | -------------------------------------------- |
| Multi-user with roles (owner/admin/member) | Yes                                               | Yes                          | —                                            |
| Workspaces (data isolation)                | Yes (schema-level `workspace_id` everywhere)      | Yes                          | Foundation for SaaS multi-tenancy            |
| Record ownership                           | Yes                                               | Yes                          | —                                            |
| @mentions / comments                       | No                                                | Yes                          | 0.3+                                         |
| Field-level permissions                    | No                                                | Enterprise: yes              | Not planned for 0.x                          |
| SSO (OAuth/SAML)                           | No (email+password; scoped API tokens for agents) | Paid tiers                   | OAuth for cloud in SaaS track                |
| Audit log UI                               | Yes (admin → audit)                               | Enterprise feature elsewhere | —                                            |
| Backups                                    | Yes (`data.backup` op + file copy)                | Managed                      | Automate schedule in ops (see PRODUCTION.md) |

## 10. Reading the map

Where we're **ahead** of every incumbent: the agent surface (operation
catalog + MCP + trust/approvals + audit). That's the product thesis and no
mainstream CRM has it natively.

Where we're **at parity** for a solo/small team: records, pipelines, kanban,
tasks, tags, custom fields, saved views, import/export, search, multi-user.

Where we're **behind** and it hurts daily use, in priority order:

1. **Contact labels + dedupe/merge** (§2) — data quality; makes every other
   view trustworthy. → 0.2
2. **Transactional email plumbing** — invites/resets/digests; blocks real
   multi-user and reminders. → 0.2
3. **Reminders/notifications** — tasks exist but nothing nudges you. → 0.2
   (email digest), richer later
4. **Stale-record surfacing** — cheap, high leverage. → 0.2
5. **Webhooks + documented API** — unlocks the integration ecosystem we
   don't have to build ourselves. → 0.3
6. **Files/attachments** — proposals, contracts on deals. → 0.3
7. **Weighted pipeline/forecast, BCC capture, enrichment** — nice-to-have
   from 0.3 onward.

Where we consciously **won't go**: email marketing suites, meeting
schedulers, built-in calling, quotes/invoicing, click-ops workflow builders.
Agents + integrations cover these without turning emcp into a suite.
