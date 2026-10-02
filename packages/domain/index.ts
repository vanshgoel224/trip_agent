// Biruni domain model. Mirrors spec §15–§19.
// Amounts are integer rupees (INR). No paise handling in the prototype.

export type TripStatus =
  | "PLANNING"
  | "BOOKED"
  | "TRAVELLING"
  | "DISRUPTED"
  | "RECOVERY_ACTIVE"
  | "AWAITING_TRAVELLER"
  | "HOME_SAFE"
  | "SETTLED";

export type DisruptionClass = "SAFETY" | "ROUTE_BLOCKED" | "LOGISTICAL";

export type ObligationClassification = "CONFIRMED" | "INFERRED" | "PROBABLE" | "UNCERTAIN";

export type Location = { name: string; lat?: number; lng?: number };

export type ItineraryLeg = {
  legId: string;
  from: string;
  to: string;
  mode: "BUS" | "TRAIN" | "FLIGHT" | "CAB" | "AUTO" | "OTHER";
  departure: string; // ISO
  arrival?: string;
  vendor?: string;
  bookingRef?: string;
  cost: number;
  status: "PLANNED" | "CONFIRMED" | "CANCELLED" | "REPLACED" | "COMPLETED";
  replacedBy?: string;
};

export type Itinerary = {
  version: number;
  origin: string;
  destination: string;
  legs: ItineraryLeg[];
};

export type Obligation = {
  id: string;
  description: string;
  amount: number;
  dueDate?: string;
  classification: ObligationClassification;
  protected: boolean;
  source: "SETU_AA" | "TRAVELLER";
};

export type ObligationMap = {
  accountBalance: number;
  obligations: Obligation[];
  committedTotal: number;
  freeBalance: number;
  refreshedAt: string;
};

export type AuthorityLedger = {
  incidentId: string;
  incidentLimit: number; // 2000
  incidentSpent: number;
  dailyLimit: number;
  dailySpent: number;
  remainingIncident: number;
  remainingDaily: number;
};

export type Route = {
  routeId: string;
  from: string;
  to: string;
  mode: ItineraryLeg["mode"];
  departure: string;
  arrival?: string;
  vendorId: string;
  vendorName: string;
  vendorRung: VendorRung;
  price: number;
  source: "LIVE" | "OFFLINE_CACHE";
};

export type VendorRung = "PINE_LABS_MERCHANT" | "UPI_OPERATOR" | "LOCAL_TRANSPORT" | "LOGGED_CASH";

export type ActionRecord = {
  actionId: string;
  kind: "PAYMENT" | "BOOKING" | "CASH_LOG" | "ALERT" | "READBACK";
  summary: string;
  amount?: number;
  at: string;
};

export type Traveller = {
  travellerId: string;
  name: string;
  age: number;
  phone?: string;
  preferredLanguage: string; // e.g. "hi-IN", "en-IN"
  dailyCeiling: number; // set by traveller (spec §8)
  emergencyContact?: { name: string; phone: string };
  emergencyAutoAlertOptIn: boolean;
  aaConsentId?: string; // Setu AA consent handle
  groupRole?: "LEADER" | "MEMBER";
};

/** Traveller-planned activity (sightseeing, meals, meetings). Not a booked transport leg. */
export type Activity = {
  activityId: string;
  date: string; // YYYY-MM-DD
  time?: string; // HH:MM
  title: string;
  location?: string;
  cost?: number;
  notes?: string;
  calendarEventId?: string;
};

export type TripState = {
  tripId: string;
  travellerId: string;
  status: TripStatus;
  incidentId?: string;
  itinerary: Itinerary;
  currentLocation?: Location;
  currentRoute?: Route;
  lastActions: ActionRecord[];
  activities?: Activity[];
  createdAt: string;
  updatedAt: string;
};

// Recovery checkpoints. Persisted on the incident so a restarted recovery
// agent resumes from the last completed step (spec §18: no hidden memory).
export type RecoveryStep =
  | "DISRUPTION_DETECTED"
  | "CLASSIFIED"
  | "OPTIONS_GENERATED"
  | "OBLIGATION_CHECKED"
  | "AUTHORITY_CHECKED"
  | "EXECUTING"
  | "UNDO_WINDOW_OPEN"
  | "VERIFIED"
  | "READBACK_SENT"
  | "AWAITING_TRAVELLER"
  | "ESCALATED_SAFETY"
  | "UNDONE"
  | "CLOSED";

export type StopReason =
  | "AUTHORITY_EXHAUSTED"
  | "OBLIGATION_AT_RISK"
  | "SAFETY_INVOLVED"
  | "ALL_PATHS_FAILED"
  | "VERIFIED_WAY_HOME"
  | "TRAVELLER_ACTION_REQUIRED"; // e.g. a live gateway needs the traveller to complete a payment link

export type Incident = {
  incidentId: string;
  tripId: string;
  description: string;
  affectedLegId?: string;
  classification?: DisruptionClass;
  step: RecoveryStep;
  options: Route[];
  chosenOption?: Route;
  /** Ranked indexes into options that passed obligation + authority checks. */
  eligible?: number[];
  pendingApproval?: { kind: "SPEND" | "ALERT_CONTACT"; route?: Route; optionIndex?: number; reason: StopReason; message: string };
  stopReason?: StopReason;
  paymentId?: string;
  bookingId?: string;
  undoActionId?: string;
  newItineraryVersion?: number;
  readback?: string;
  hasVerifiedWayHome: boolean;
  timeline: { at: string; step: string; detail: string }[];
  createdAt: string;
  updatedAt: string;
};

export type AgentName =
  | "orchestrator"
  | "finance"
  | "recovery"
  | "compliance"
  | "voice"
  | "travel"
  | "booking";

export type AgentRun = {
  runId: string;
  tripId: string;
  incidentId?: string;
  agent: AgentName;
  input: unknown;
  output?: unknown;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "WAITING";
  attempt: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
};

export type AuditRecord = {
  auditId: string;
  tripId: string;
  incidentId?: string;
  agent: string;
  tool: string;
  action: string;
  reasonCode: string;
  amount?: number;
  authorityBefore?: number;
  authorityAfter?: number;
  obligationCheck: "PASS" | "FAIL";
  complianceCheck: "PASS" | "FAIL";
  result: "SUCCESS" | "FAILED" | "BLOCKED";
  timestamp: string;
};

export type ErrorCode =
  | "INVALID_REQUEST"
  | "AUTH_FAILURE"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "NETWORK_FAILURE"
  | "EXTERNAL_FAILURE"
  | "ALREADY_COMPLETED"
  | "POLICY_BLOCKED"
  | "AUTHORITY_EXCEEDED"
  | "OBLIGATION_BLOCKED"
  | "USER_REQUIRED";

export type ToolResult<T = unknown> = {
  success: boolean;
  toolCallId: string;
  status: string;
  data?: T;
  error?: { code: ErrorCode; message: string; retryable: boolean };
  auditId: string;
};

export type UndoAction = {
  undoId: string;
  tripId: string;
  incidentId: string;
  paymentId?: string;
  bookingId?: string;
  amount: number;
  openedAt: string;
  expiresAt: string;
  status: "OPEN" | "CANCELLED" | "EXPIRED" | "COMPENSATED";
};

export type PaymentRecord = {
  paymentId: string;
  idempotencyKey: string;
  incidentId: string;
  tripId: string;
  amount: number;
  rung: VendorRung;
  vendorId: string;
  status: "PENDING" | "SUCCESS" | "FAILED" | "REFUNDED";
  externalRef?: string;
  createdAt: string;
  updatedAt: string;
};

export type BookingRecord = {
  bookingId: string;
  idempotencyKey: string;
  tripId: string;
  incidentId?: string;
  routeId: string;
  paymentId?: string;
  status: "CONFIRMED" | "CANCELLED";
  pnr: string;
  createdAt: string;
};

export type TransactionKind = "RESERVE" | "COMMIT" | "RELEASE" | "RESTORE";

export type LedgerTransaction = {
  txnId: string;
  incidentId: string;
  tripId: string;
  kind: TransactionKind;
  amount: number;
  reference: string; // idempotency key
  at: string;
};

export type Debit = {
  date: string; // ISO date
  narration: string;
  amount: number;
};
