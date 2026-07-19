/**
 * Repository ports — the persistence seam. Every method is asynchronous
 * (returns a Promise) so adapters are free to talk to embedded or networked
 * stores behind the same contract. The V1 SQLite adapter (`packages/db`)
 * fulfils these signatures with synchronous better-sqlite3 work inside async
 * methods; an async-capable adapter (e.g. Postgres) can await real I/O.
 *
 * Every method is already workspace-scoped by construction: implementations
 * are constructed per-request with the RequestContext's workspaceId.
 */
import type {
  Activity,
  ActivityFilter,
  AuditEvent,
  Company,
  CompanyFilter,
  CompanyListItem,
  CompanyPersonLink,
  ContactList,
  ContactListWithCounts,
  CustomFieldDef,
  CustomFieldEntity,
  CustomFieldValue,
  Deal,
  DealFilter,
  DealListItem,
  DealStakeholder,
  Engagement,
  EngagementFilter,
  EngagementListItem,
  ListableType,
  McpClient,
  Offering,
  OfferingLink,
  Page,
  PendingAction,
  PendingStatus,
  Person,
  PersonFilter,
  PersonListItem,
  Pipeline,
  PipelineType,
  SavedView,
  SearchHit,
  Stage,
  Tag,
  TaggableType,
  User,
  Workspace,
  ActorType,
  Surface,
} from "./domain.ts";
import type { Role, McpScope, TrustProfile } from "./policy.ts";

export interface AuditInput {
  operation: string;
  entityType?: string | null;
  entityId?: string | null;
  summary: string;
  meta?: Record<string, unknown> | null;
}

export interface ActorStamp {
  actorType: ActorType;
  actorUserId: string | null;
  actorClientId: string | null;
  surface: Surface;
}

export interface WorkspacePort {
  get(): Promise<Workspace>;
  update(patch: Partial<Pick<Workspace, "name" | "defaultCurrency" | "timezone" | "settings">>): Promise<Workspace>;
}

export interface UserPort {
  list(): Promise<User[]>;
  get(id: string): Promise<User | null>;
  getByEmail(email: string): Promise<(User & { passwordHash: string | null }) | null>;
  create(input: { name: string; email: string; role: Role; passwordHash: string | null }): Promise<User>;
  update(id: string, patch: { name?: string; role?: Role; disabledAt?: string | null }): Promise<User>;
  setPassword(id: string, passwordHash: string): Promise<void>;
  count(): Promise<number>;
  /** Creates a `pending` user + membership (no credential); email must be free; role may not be owner. */
  createPending(input: { email: string; name: string; role: Role }): Promise<{ userId: string }>;
  /**
   * Permanently deletes a non-owner user: user row, credentials/subject link,
   * sessions, memberships, MCP clients and private saved views go; business
   * records remain (actors render as "Deleted user") with ownerships/task
   * assignments cleared (docs/issues/0022).
   */
  deletePermanently(userId: string): Promise<void>;
  /** Atomically makes `toUserId` (active, same workspace) the owner and demotes the previous owner to admin. */
  transferOwnership(fromUserId: string, toUserId: string): Promise<void>;
  /**
   * Hard-delete every login session belonging to the user; returns the number
   * of rows removed. Called by `user.update` inside the same transaction when
   * a user is disabled — disabling immediately ends all sessions, and
   * re-enabling restores nothing (docs/issues/0022). Optional only until every
   * adapter implements it; the SQLite adapter does.
   */
  /** Hard-delete every session row for the user (disable/delete sweep). */
  deleteSessions(userId: string): Promise<number>;
}

export interface CompanyPort {
  list(filter: CompanyFilter): Promise<Page<CompanyListItem>>;
  get(id: string): Promise<Company | null>;
  getByName(name: string): Promise<Company | null>;
  create(input: Partial<Company> & { name: string }): Promise<Company>;
  update(id: string, patch: Partial<Company>): Promise<Company>;
  setArchived(id: string, archived: boolean): Promise<Company>;
  hardDelete(id: string): Promise<void>;
  people(companyId: string): Promise<Array<CompanyPersonLink & { person: Person }>>;
}

export interface PersonPort {
  list(filter: PersonFilter): Promise<Page<PersonListItem>>;
  get(id: string): Promise<Person | null>;
  create(input: Partial<Person> & { name: string }): Promise<Person>;
  update(id: string, patch: Partial<Person>): Promise<Person>;
  setArchived(id: string, archived: boolean): Promise<Person>;
  hardDelete(id: string): Promise<void>;
  companies(personId: string): Promise<Array<CompanyPersonLink & { company: Company }>>;
  link(input: {
    companyId: string;
    personId: string;
    roleTitle?: string | null;
    isPrimary?: boolean;
    status?: "current" | "past";
  }): Promise<CompanyPersonLink>;
  unlink(companyId: string, personId: string): Promise<void>;
}

export interface PipelinePort {
  list(type?: PipelineType): Promise<Pipeline[]>;
  get(id: string): Promise<Pipeline | null>;
  getDefault(type: PipelineType): Promise<Pipeline | null>;
  getStage(stageId: string): Promise<Stage | null>;
  create(input: {
    type: PipelineType;
    name: string;
    isDefault: boolean;
    stages: Array<{ name: string; color: string; probability?: number | null; outcome?: string | null }>;
  }): Promise<Pipeline>;
  rename(id: string, name: string): Promise<Pipeline>;
  setDefault(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  addStage(
    pipelineId: string,
    input: { name: string; color: string; probability?: number | null; outcome?: string | null },
  ): Promise<Stage>;
  updateStage(
    stageId: string,
    patch: { name?: string; color?: string; probability?: number | null; outcome?: string | null },
  ): Promise<Stage>;
  reorderStages(pipelineId: string, stageIds: string[]): Promise<void>;
  deleteStage(stageId: string): Promise<void>;
  stageUsage(stageId: string): Promise<number>;
  pipelineUsage(pipelineId: string): Promise<number>;
}

export interface EngagementPort {
  list(filter: EngagementFilter): Promise<Page<EngagementListItem>>;
  get(id: string): Promise<Engagement | null>;
  create(input: Partial<Engagement> & { title: string; pipelineId: string; stageId: string }): Promise<Engagement>;
  update(id: string, patch: Partial<Engagement>): Promise<Engagement>;
  setArchived(id: string, archived: boolean): Promise<Engagement>;
  hardDelete(id: string): Promise<void>;
  countByStage(pipelineId: string): Promise<Array<{ stageId: string; count: number }>>;
}

export interface DealPort {
  list(filter: DealFilter): Promise<Page<DealListItem>>;
  get(id: string): Promise<Deal | null>;
  create(input: Partial<Deal> & { title: string; pipelineId: string; stageId: string; currency: string }): Promise<Deal>;
  update(id: string, patch: Partial<Deal>): Promise<Deal>;
  setArchived(id: string, archived: boolean): Promise<Deal>;
  hardDelete(id: string): Promise<void>;
  stakeholders(dealId: string): Promise<Array<DealStakeholder & { person: Person }>>;
  addStakeholder(input: {
    dealId: string;
    personId: string;
    role?: string | null;
    isPrimary?: boolean;
    note?: string | null;
  }): Promise<DealStakeholder>;
  updateStakeholder(id: string, patch: { role?: string | null; isPrimary?: boolean; note?: string | null }): Promise<DealStakeholder>;
  removeStakeholder(id: string): Promise<void>;
  getStakeholder(id: string): Promise<DealStakeholder | null>;
  stageStats(
    pipelineId: string,
  ): Promise<Array<{ stageId: string; count: number; sums: Record<string, number>; weighted: Record<string, number> }>>;
}

export interface OfferingPort {
  list(includeArchived: boolean): Promise<Offering[]>;
  get(id: string): Promise<Offering | null>;
  create(input: Partial<Offering> & { name: string; type: string }): Promise<Offering>;
  update(id: string, patch: Partial<Offering>): Promise<Offering>;
  setArchived(id: string, archived: boolean): Promise<Offering>;
  hardDelete(id: string): Promise<void>;
  links(entityType: "engagement" | "deal", entityId: string): Promise<Array<OfferingLink & { offering: Offering }>>;
  /** Light per-row projection for list views, keyed by entity id. */
  linksForEntities(
    entityType: "engagement" | "deal",
    entityIds: string[],
  ): Promise<Record<string, Array<{ id: string; name: string; isPrimary: boolean }>>>;
  linksForOffering(offeringId: string): Promise<OfferingLink[]>;
  link(input: {
    offeringId: string;
    entityType: "engagement" | "deal";
    entityId: string;
    fit?: string | null;
    note?: string | null;
    isPrimary?: boolean;
  }): Promise<OfferingLink>;
  unlink(offeringId: string, entityType: "engagement" | "deal", entityId: string): Promise<void>;
}

export interface ActivityPort {
  list(filter: ActivityFilter): Promise<Page<Activity>>;
  get(id: string): Promise<Activity | null>;
  create(
    input: Partial<Activity> & { kind: Activity["kind"] },
    actor: ActorStamp,
  ): Promise<Activity>;
  update(id: string, patch: Partial<Activity>): Promise<Activity>;
  hardDelete(id: string): Promise<void>;
  /** Bumps lastActivityAt denormalization on linked engagement/deal. */
  touchLinked(activity: Pick<Activity, "engagementId" | "dealId">, at: string): Promise<void>;
}

export interface TagPort {
  list(): Promise<Array<Tag & { usage: number }>>;
  get(id: string): Promise<Tag | null>;
  getByName(name: string): Promise<Tag | null>;
  create(input: { name: string; color: string }): Promise<Tag>;
  update(id: string, patch: { name?: string; color?: string }): Promise<Tag>;
  delete(id: string): Promise<void>;
  apply(tagId: string, entityType: TaggableType, entityId: string): Promise<void>;
  remove(tagId: string, entityType: TaggableType, entityId: string): Promise<void>;
  forEntity(entityType: TaggableType, entityId: string): Promise<Tag[]>;
  forEntities(entityType: TaggableType, entityIds: string[]): Promise<Record<string, Tag[]>>;
}

export interface ListPort {
  list(): Promise<ContactListWithCounts[]>;
  get(id: string): Promise<ContactList | null>;
  getByName(name: string): Promise<ContactList | null>;
  create(input: {
    name: string;
    description?: string | null;
    color: string;
    entityType?: ListableType | null;
  }): Promise<ContactList>;
  update(
    id: string,
    patch: { name?: string; description?: string | null; color?: string; entityType?: ListableType | null },
  ): Promise<ContactList>;
  /** Deletes the list and detaches all members. */
  delete(id: string): Promise<void>;
  memberTypeCounts(listId: string): Promise<Record<string, number>>;
  /** Idempotent bulk attach; returns the number of rows actually inserted. */
  addMembers(listId: string, entityType: ListableType, entityIds: string[]): Promise<number>;
  /** Returns the number of rows actually removed. */
  removeMembers(listId: string, entityType: ListableType, entityIds: string[]): Promise<number>;
  forEntity(entityType: ListableType, entityId: string): Promise<ContactList[]>;
  forEntities(entityType: ListableType, entityIds: string[]): Promise<Record<string, ContactList[]>>;
}

export interface CustomFieldPort {
  listDefs(entityType?: CustomFieldEntity, includeArchived?: boolean): Promise<CustomFieldDef[]>;
  getDef(id: string): Promise<CustomFieldDef | null>;
  getDefByKey(entityType: CustomFieldEntity, key: string): Promise<CustomFieldDef | null>;
  createDef(input: {
    entityType: CustomFieldEntity;
    key: string;
    label: string;
    type: string;
    options: string[] | null;
    required: boolean;
  }): Promise<CustomFieldDef>;
  updateDef(id: string, patch: { label?: string; options?: string[] | null; required?: boolean }): Promise<CustomFieldDef>;
  setDefArchived(id: string, archived: boolean): Promise<CustomFieldDef>;
  setValue(fieldId: string, entityType: CustomFieldEntity, entityId: string, value: CustomFieldValue): Promise<void>;
  values(entityType: CustomFieldEntity, entityId: string): Promise<Record<string, CustomFieldValue>>;
}

export interface SavedViewPort {
  list(userId: string | null): Promise<SavedView[]>;
  get(id: string): Promise<SavedView | null>;
  create(input: {
    name: string;
    entityType: string;
    filters: Record<string, unknown>;
    visibility: string;
    ownerUserId: string | null;
  }): Promise<SavedView>;
  update(id: string, patch: { name?: string; filters?: Record<string, unknown>; visibility?: string }): Promise<SavedView>;
  delete(id: string): Promise<void>;
}

export interface PendingActionPort {
  list(status?: PendingStatus): Promise<PendingAction[]>;
  get(id: string): Promise<PendingAction | null>;
  create(input: {
    operation: string;
    input: Record<string, unknown>;
    preview: Record<string, unknown> | null;
    riskCategory: string;
    actor: ActorStamp;
    expiresAt: string;
  }): Promise<PendingAction>;
  setStatus(
    id: string,
    patch: {
      status: PendingStatus;
      reviewedByUserId?: string | null;
      reviewNote?: string | null;
      result?: Record<string, unknown> | null;
    },
  ): Promise<PendingAction>;
  countPending(): Promise<number>;
}

export interface AuditPort {
  record(input: AuditInput, actor: ActorStamp): Promise<AuditEvent>;
  list(filter: {
    actorType?: ActorType;
    operation?: string;
    entityType?: string;
    entityId?: string;
    limit: number;
    offset: number;
  }): Promise<Page<AuditEvent>>;
}

export interface McpClientPort {
  list(): Promise<McpClient[]>;
  get(id: string): Promise<McpClient | null>;
  getByTokenHash(hash: string): Promise<(McpClient & { workspaceId: string }) | null>;
  create(input: {
    name: string;
    tokenHash: string;
    tokenPrefix: string;
    scopes: McpScope[];
    trust: TrustProfile;
    createdByUserId: string | null;
  }): Promise<McpClient>;
  update(id: string, patch: { name?: string; scopes?: McpScope[]; trust?: TrustProfile }): Promise<McpClient>;
  revoke(id: string): Promise<McpClient>;
  /**
   * Revoke (set revokedAt — same semantics as `revoke`, never delete) every
   * active client created by the user; returns the number revoked. Called by
   * `user.update` inside the same transaction when a user is disabled;
   * re-enabling the user does NOT un-revoke (docs/issues/0022). Optional only
   * until every adapter implements it; the SQLite adapter does.
   */
  /** Revoke (never delete) all still-active clients created by the user. */
  revokeAllForUser(userId: string): Promise<number>;
  touchLastUsed(id: string): Promise<void>;
}

/**
 * Credential lifecycle seam (docs/issues/0022): passwords live in OpenAuth's
 * storage, the CRM only brokers single-use codes and the forced-change flag.
 */
export interface CredentialsPort {
  /** Issues a hashed single-use setup/reset code (invalidates prior codes of that purpose; `reset` also ends the user's sessions). Returns the raw code exactly once. */
  issueCode(userId: string, purpose: "setup" | "reset"): Promise<{ code: string }>;
  /** Sets/clears `password_must_change`; while set, every operation except password change/logout/whoami is refused. */
  mustChangePassword(userId: string, flag: boolean): Promise<void>;
}

export interface SearchPort {
  global(query: string, limit: number): Promise<SearchHit[]>;
}

export interface MaintenancePort {
  /** SQLite VACUUM INTO a timestamped file. Returns the absolute path. */
  backup(): Promise<string>;
  counts(): Promise<{ companies: number; people: number; engagements: number; deals: number; openDeals: number }>;
}

/** Everything an operation handler can touch, scoped to one workspace. */
export interface Ports {
  workspace: WorkspacePort;
  users: UserPort;
  companies: CompanyPort;
  people: PersonPort;
  pipelines: PipelinePort;
  engagements: EngagementPort;
  deals: DealPort;
  offerings: OfferingPort;
  activities: ActivityPort;
  tags: TagPort;
  lists: ListPort;
  customFields: CustomFieldPort;
  savedViews: SavedViewPort;
  pendingActions: PendingActionPort;
  audit: AuditPort;
  mcpClients: McpClientPort;
  credentials: CredentialsPort;
  search: SearchPort;
  maintenance: MaintenancePort;
  /**
   * Run fn atomically. Nested calls join the outer transaction.
   * Adapters must guarantee the awaited fn commits only after it fully
   * resolves and rolls back when it rejects.
   */
  tx<T>(fn: () => Promise<T>): Promise<T>;
}
