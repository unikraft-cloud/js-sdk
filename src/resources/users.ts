// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import type * as models from "../api/platform/models.gen.js";
import { UsersApi } from "../api/platform/users.gen.js";
import { type MetroFailure, fanoutError, fanoutSettled } from "../core/fanout.js";
import type { MetroEndpoint, MetroScope } from "../core/metro.js";
import {
  Resource,
  type ScopeOptions,
  type WithMetro,
  listTagged,
  withMetro,
} from "../core/resource.js";
import type { Session } from "../core/session.js";

/** A quota, tagged with the metro it applies to. */
export type Quota = WithMetro<models.Quotas>;

/**
 * Idiomatic client for Unikraft Cloud users and quotas. Quotas are per-metro, so
 * reading them fans out across the scope and tags each entry with its metro.
 */
export class Users extends Resource<UsersApi> {
  protected readonly noun = "user";

  constructor(session: Session, scope: MetroScope) {
    super(session, scope, new UsersApi(session.platform));
  }

  /** The authenticated user's quotas, in every metro in scope. */
  quotas(opts: ScopeOptions = {}): Promise<Quota[]> {
    return this.#quotas(opts, (endpoint) =>
      listTagged(this.api.getUser(this.call(endpoint, opts)), "quotas", endpoint.metro),
    );
  }

  /** A specific user's quotas by UUID, in every metro in scope. */
  quotasByUuid(uuid: string, opts: ScopeOptions = {}): Promise<Quota[]> {
    return this.#quotas(opts, (endpoint) =>
      listTagged(this.api.getUserByUuid(uuid, this.call(endpoint, opts)), "quotas", endpoint.metro),
    );
  }

  /**
   * Add one or more users to the account. Membership is account-wide, so this
   * targets a single metro: the client's, or the default when the scope spans
   * several.
   */
  async add(spec: models.AddUsersRequest, opts: ScopeOptions = {}) {
    const endpoint = await this.oneEndpoint("Adding users", opts);
    return listTagged(
      this.api.addUsers({ body: spec, ...this.call(endpoint, opts) }),
      "results",
      endpoint.metro,
    );
  }

  /** Read per-metro quotas concurrently; report every metro that failed. */
  async #quotas(
    opts: ScopeOptions,
    each: (endpoint: MetroEndpoint) => Promise<Quota[]>,
  ): Promise<Quota[]> {
    const endpoints = await this.endpoints(opts);
    if (endpoints.length === 1) return each(endpoints[0] as MetroEndpoint);

    const outcomes = await fanoutSettled(endpoints, each);
    const quotas: Quota[] = [];
    const failures: MetroFailure[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) quotas.push(...outcome.value);
      else failures.push({ metro: outcome.endpoint.metro, error: outcome.error });
    }
    if (failures.length > 0) throw fanoutError(endpoints.length, failures);
    return quotas;
  }
}
