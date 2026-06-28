import { assertEquals } from "@std/assert";
import {
  ObservationStatus,
  type ObservationStatus as ObservationStatusType,
  ServiceStatus,
  type ServiceStatus as ServiceStatusType,
} from "./enums.ts";

// These constants are the DB contract: the exact strings persisted in
// service_registry.status and service_observations.status. Pin the runtime
// values so a rename of a constant can never silently re-drift what the SQL
// stores/queries (the `success` vs `ok` class of bug from PR #75). If you change
// a value here, you are changing the data contract — update the DB rows too.

Deno.test("ServiceStatus pins its persisted string values", () => {
  assertEquals(ServiceStatus.ACTIVE, "active");
  assertEquals(ServiceStatus.PROBATION, "probation");
  assertEquals(ServiceStatus.BLOCKED, "blocked");
  assertEquals(ServiceStatus.VETTING, "vetting");
});

Deno.test("ObservationStatus pins its persisted string values", () => {
  assertEquals(ObservationStatus.OK, "ok");
  assertEquals(ObservationStatus.ERROR, "error");
});

Deno.test("status unions are exhaustive over their constants", () => {
  // Compile-time exhaustiveness: every union member must be a constant value and
  // vice versa. If a constant is added/removed without updating the type (or a
  // stray member is introduced), one of these assignments stops type-checking.
  const everyService: Record<ServiceStatusType, true> = {
    active: true,
    probation: true,
    blocked: true,
    vetting: true,
  };
  const everyObservation: Record<ObservationStatusType, true> = {
    ok: true,
    error: true,
  };

  assertEquals(
    Object.keys(everyService).sort(),
    [
      ...Object.values(ServiceStatus),
    ].sort(),
  );
  assertEquals(
    Object.keys(everyObservation).sort(),
    [
      ...Object.values(ObservationStatus),
    ].sort(),
  );
});
