/**
 * Repository ports — the persistence seam. `packages/db` implements these with
 * Drizzle + better-sqlite3. Methods are synchronous on purpose: the V1 store
 * is an embedded single-writer SQLite file and sync repos make transactional
 * operation handlers trivial. The Postgres adapter (0.3) will flip these to
 * async in one mechanical refactor.
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
  get(): Workspace;
  update(patch: Partial<Pick<Workspace, "name" | "defaultCurrency" | "timezone" | "settings">>): Workspace;
}

export interface UserPort {
  list(): User[];
  get(id: string): User | null;
  getByEmail(email: string): (User & { passwordHash: string | null }) | null;
  create(input: { name: string; email: string; role: Role; passwordHash: string | null }): User;
  update(id: string, patch: { name?: string; role?: Role; disabledAt?: string | null }): User;
  setPassword(id: string, passwordHash: string): void;
  count(): number;
}

export interface CompanyPort {
  list(filter: CompanyFilter): Page<CompanyListItem>;
  get(id: string): Company | null;
  getByName(name: string): Company | null;
  create(input: Partial<Company> & { name: string }): Company;
  update(id: string, patch: Partial<Company>): Company;
  setArchived(id: string, archived: boolean): Company;
  hardDelete(id: string): void;
  people(companyId: string): Array<CompanyPersonLink & { person: Person }>;
}

export interface PersonPort {
  list(filter: PersonFilter): Page<PersonListItem>;
  get(id: string): Person | null;
  create(input: Partial<Person> & { name: string }): Person;
  update(id: string, patch: Partial<Person>): Person;
  setArchived(id: string, archived: boolean): Person;
  hardDelete(id: string): void;
  companies(personId: string): Array<CompanyPersonLink & { company: Company }>;
  link(input: {
    companyId: string;
    personId: string;
    roleTitle?: string | null;
    isPrimary?: boolean;
    status?: "current" | "past";
  }): CompanyPersonLink;
  unlink(companyId: string, personId: string): void;
}

export interface PipelinePort {
  list(type?: PipelineType): Pipeline[];
  get(id: string): Pipeline | null;
  getDefault(type: PipelineType): Pipeline | null;
  getStage(stageId: string): Stage | null;
  create(input: {
    type: PipelineType;
    name: string;
    isDefault: boolean;
    stages: Array<{ name: string; color: string; probability?: number | null; outcome?: string | null }>;
  }): Pipeline;
  rename(id: string, name: string): Pipeline;
  setDefault(id: string): void;
  delete(id: string): void;
  addStage(pipelineId: string, input: { name: string; color: string; probability?: number | null; outcome?: string | null }): Stage;
  updateStage(stageId: string, patch: { name?: string; color?: string; probability?: number | null; outcome?: string | null }): Stage;
  reorderStages(pipelineId: string, stageIds: string[]): void;
  deleteStage(stageId: string): void;
  stageUsage(stageId: string): number;
  pipelineUsage(pipelineId: string): number;
}

export interface EngagementPort {
  list(filter: EngagementFilter): Page<EngagementListItem>;
  get(id: string): Engagement | null;
  create(input: Partial<Engagement> & { title: string; pipelineId: string; stageId: string }): Engagement;
  update(id: string, patch: Partial<Engagement>): Engagement;
  setArchived(id: string, archived: boolean): Engagement;
  hardDelete(id: string): void;
  countByStage(pipelineId: string): Array<{ stageId: string; count: number }>;
}

export interface DealPort {
  list(filter: DealFilter): Page<DealListItem>;
  get(id: string): Deal | null;
  create(input: Partial<Deal> & { title: string; pipelineId: string; stageId: string; currency: string }): Deal;
  update(id: string, patch: Partial<Deal>): Deal;
  setArchived(id: string, archived: boolean): Deal;
  hardDelete(id: string): void;
  stakeholders(dealId: string): Array<DealStakeholder & { person: Person }>;
  addStakeholder(input: { dealId: string; personId: string; role?: string | null; isPrimary?: boolean; note?: string | null }): DealStakeholder;
  updateStakeholder(id: string, patch: { role?: string | null; isPrimary?: boolean; note?: string | null }): DealStakeholder;
  removeStakeholder(id: string): void;
  getStakeholder(id: string): DealStakeholder | null;
  stageStats(pipelineId: string): Array<{ stageId: string; count: number; sums: Record<string, number>; weighted: Record<string, number> }>;
}

export interface OfferingPort {
  list(includeArchived: boolean): Offering[];
  get(id: string): Offering | null;
  create(input: Partial<Offering> & { name: string; type: string }): Offering;
  update(id: string, patch: Partial<Offering>): Offering;
  setArchived(id: string, archived: boolean): Offering;
  hardDelete(id: string): void;
  links(entityType: "engagement" | "deal", entityId: string): Array<OfferingLink & { offering: Offering }>;
  /** Light per-row projection for list views, keyed by entity id. */
  linksForEntities(
    entityType: "engagement" | "deal",
    entityIds: string[],
  ): Record<string, Array<{ id: string; name: string; isPrimary: boolean }>>;
  linksForOffering(offeringId: string): OfferingLink[];
  link(input: {
    offeringId: string;
    entityType: "engagement" | "deal";
    entityId: string;
    fit?: string | null;
    note?: string | null;
    isPrimary?: boolean;
  }): OfferingLink;
  unlink(offeringId: string, entityType: "engagement" | "deal", entityId: string): void;
}

export interface ActivityPort {
  list(filter: ActivityFilter): Page<Activity>;
  get(id: string): Activity | null;
  create(
    input: Partial<Activity> & { kind: Activity["kind"] },
    actor: ActorStamp,
  ): Activity;
  update(id: string, patch: Partial<Activity>): Activity;
  hardDelete(id: string): void;
  /** Bumps lastActivityAt denormalization on linked engagement/deal. */
  touchLinked(activity: Pick<Activity, "engagementId" | "dealId">, at: string): void;
}

export interface TagPort {
  list(): Array<Tag & { usage: number }>;
  get(id: string): Tag | null;
  getByName(name: string): Tag | null;
  create(input: { name: string; color: string }): Tag;
  update(id: string, patch: { name?: string; color?: string }): Tag;
  delete(id: string): void;
  apply(tagId: string, entityType: TaggableType, entityId: string): void;
  remove(tagId: string, entityType: TaggableType, entityId: string): void;
  forEntity(entityType: TaggableType, entityId: string): Tag[];
  forEntities(entityType: TaggableType, entityIds: string[]): Record<string, Tag[]>;
}

export interface ListPort {
  list(): ContactListWithCounts[];
  get(id: string): ContactList | null;
  getByName(name: string): ContactList | null;
  create(input: { name: string; description?: string | null; color: string; entityType?: ListableType | null }): ContactList;
  update(id: string, patch: { name?: string; description?: string | null; color?: string; entityType?: ListableType | null }): ContactList;
  /** Deletes the list and detaches all members. */
  delete(id: string): void;
  memberTypeCounts(listId: string): Record<string, number>;
  /** Idempotent bulk attach; returns the number of rows actually inserted. */
  addMembers(listId: string, entityType: ListableType, entityIds: string[]): number;
  /** Returns the number of rows actually removed. */
  removeMembers(listId: string, entityType: ListableType, entityIds: string[]): number;
  forEntity(entityType: ListableType, entityId: string): ContactList[];
  forEntities(entityType: ListableType, entityIds: string[]): Record<string, ContactList[]>;
}

export interface CustomFieldPort {
  listDefs(entityType?: CustomFieldEntity, includeArchived?: boolean): CustomFieldDef[];
  getDef(id: string): CustomFieldDef | null;
  getDefByKey(entityType: CustomFieldEntity, key: string): CustomFieldDef | null;
  createDef(input: {
    entityType: CustomFieldEntity;
    key: string;
    label: string;
    type: string;
    options: string[] | null;
    required: boolean;
  }): CustomFieldDef;
  updateDef(id: string, patch: { label?: string; options?: string[] | null; required?: boolean }): CustomFieldDef;
  setDefArchived(id: string, archived: boolean): CustomFieldDef;
  setValue(fieldId: string, entityType: CustomFieldEntity, entityId: string, value: CustomFieldValue): void;
  values(entityType: CustomFieldEntity, entityId: string): Record<string, CustomFieldValue>;
}

export interface SavedViewPort {
  list(userId: string | null): SavedView[];
  get(id: string): SavedView | null;
  create(input: {
    name: string;
    entityType: string;
    filters: Record<string, unknown>;
    visibility: string;
    ownerUserId: string | null;
  }): SavedView;
  update(id: string, patch: { name?: string; filters?: Record<string, unknown>; visibility?: string }): SavedView;
  delete(id: string): void;
}

export interface PendingActionPort {
  list(status?: PendingStatus): PendingAction[];
  get(id: string): PendingAction | null;
  create(input: {
    operation: string;
    input: Record<string, unknown>;
    preview: Record<string, unknown> | null;
    riskCategory: string;
    actor: ActorStamp;
    expiresAt: string;
  }): PendingAction;
  setStatus(
    id: string,
    patch: {
      status: PendingStatus;
      reviewedByUserId?: string | null;
      reviewNote?: string | null;
      result?: Record<string, unknown> | null;
    },
  ): PendingAction;
  countPending(): number;
}

export interface AuditPort {
  record(input: AuditInput, actor: ActorStamp): AuditEvent;
  list(filter: {
    actorType?: ActorType;
    operation?: string;
    entityType?: string;
    entityId?: string;
    limit: number;
    offset: number;
  }): Page<AuditEvent>;
}

export interface McpClientPort {
  list(): McpClient[];
  get(id: string): McpClient | null;
  getByTokenHash(hash: string): (McpClient & { workspaceId: string }) | null;
  create(input: {
    name: string;
    tokenHash: string;
    tokenPrefix: string;
    scopes: McpScope[];
    trust: TrustProfile;
    createdByUserId: string | null;
  }): McpClient;
  update(id: string, patch: { name?: string; scopes?: McpScope[]; trust?: TrustProfile }): McpClient;
  revoke(id: string): McpClient;
  touchLastUsed(id: string): void;
}

export interface SearchPort {
  global(query: string, limit: number): SearchHit[];
}

export interface MaintenancePort {
  /** SQLite VACUUM INTO a timestamped file. Returns the absolute path. */
  backup(): string;
  counts(): { companies: number; people: number; engagements: number; deals: number; openDeals: number };
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
  search: SearchPort;
  maintenance: MaintenancePort;
  /** Run fn atomically. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T;
}
