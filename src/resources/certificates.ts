// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, Unikraft GmbH.

import { CertificatesApi } from "../api/platform/certificates.gen.js";
import type * as models from "../api/platform/models.gen.js";
import { fanout } from "../core/fanout.js";
import { HandleSet } from "../core/handle-set.js";
import { type HandleSteps, type MetroTarget, ResourceHandle } from "../core/handle.js";
import type { CallOptions } from "../core/http.js";
import type { MetroEndpoint, MetroScope } from "../core/metro.js";
import { paginate } from "../core/pagination.js";
import {
  type EntryOf,
  type ListEnvelope,
  type MetroGroup,
  Resource,
  type ScopeOptions,
  type WithMetro,
  firstTagged,
  listTagged,
  withMetro,
} from "../core/resource.js";
import { type Ref, describeRef, orAbsent, toQuery, unwrapList } from "../core/response.js";
import type { Session } from "../core/session.js";

/** Reference(s) accepted by certificate operations: `{ name }` or `{ uuid }`. */
export type CertificateRef = Ref;

/** Fields updated by {@link CertificateHandle.update}. */
export type CertificateUpdate = Pick<models.UpdateCertificatesRequestItem, "chain" | "pkey">;

/** Options for {@link Certificates.list}. */
export interface ListCertificatesOptions extends ScopeOptions {
  details?: boolean;
  pageSize?: number;
}

/** A certificate, tagged with the metro it lives in. */
export type Certificate = WithMetro<models.Certificate>;

/** A chainable reference to one certificate in one metro. */
export class CertificateHandle<T> extends ResourceHandle<T> {
  readonly #certificates: Certificates;

  constructor(certificates: Certificates, steps: HandleSteps<T>) {
    super(steps);
    this.#certificates = certificates;
  }

  /** Re-read the certificate's full details. */
  refresh(opts: CallOptions = {}): CertificateHandle<Certificate> {
    return this.#then((target) => this.#certificates.fetch(target, opts));
  }

  /** Replace the certificate's chain and/or private key. */
  update(spec: CertificateUpdate, opts: CallOptions = {}) {
    return this.#then((target) =>
      this.#one(
        target,
        this.#certificates.api.updateCertificates({
          body: [{ ...target.ref, ...spec }],
          ...call(target, opts),
        }),
      ),
    );
  }

  /** Delete the certificate. */
  delete(opts: CallOptions = {}) {
    return this.#then((target) =>
      this.#one(
        target,
        this.#certificates.api.deleteCertificates({ body: [target.ref], ...call(target, opts) }),
      ),
    );
  }

  #then<R>(fetch: (target: MetroTarget) => Promise<R>): CertificateHandle<R> {
    return new CertificateHandle(this.#certificates, {
      locate: async () => ({ target: await this.next() }),
      fetch,
      sequential: true,
    });
  }

  #one<R extends ListEnvelope<"certificates">>(target: MetroTarget, work: Promise<R>) {
    return firstTagged(
      work,
      "certificates",
      target.metro,
      `certificate ${describeRef(target.ref)}`,
    );
  }
}

/** Per-call options for a plumbing call pinned to one metro. */
function call(target: MetroTarget, opts: CallOptions): CallOptions {
  return { ...opts, baseUrl: target.baseUrl };
}

/**
 * Every certificate matching one ref, one per metro — the same certificate is
 * commonly installed in all of them.
 *
 * @example
 * await ukc.certificates.each({ name: "star-example" }).update({ chain, pkey });
 */
export class CertificateSet extends HandleSet<CertificateHandle<Certificate>, Certificate> {
  /** Re-read every match's full details. */
  refresh(opts: CallOptions = {}) {
    return this.map((handle) => handle.refresh(opts));
  }

  /** Replace the chain and/or private key of every match. */
  update(spec: CertificateUpdate, opts: CallOptions = {}) {
    return this.map((handle) => handle.update(spec, opts));
  }

  /** Delete every match. */
  delete(opts: CallOptions = {}) {
    return this.map((handle) => handle.delete(opts));
  }
}

/** Idiomatic client for Unikraft Cloud certificates. */
export class Certificates extends Resource<CertificatesApi> {
  protected readonly noun = "certificate";

  constructor(session: Session, scope: MetroScope) {
    super(session, scope, new CertificatesApi(session.platform));
  }

  /** Create a certificate in a single metro and return a handle to it. */
  create(
    spec: models.CreateCertificateRequest,
    opts: ScopeOptions = {},
  ): CertificateHandle<Certificate> {
    return new CertificateHandle(this, {
      locate: async () => {
        const endpoint = await this.oneEndpoint("Creating a certificate", opts);
        const cert = (await firstTagged(
          this.api.createCertificate({ body: spec, ...this.call(endpoint, opts) }),
          "certificates",
          endpoint.metro,
          "certificate",
        )) as Certificate;
        const ref: Ref =
          cert.uuid !== undefined ? { uuid: cert.uuid } : ({ name: cert.name } as Ref);
        return { target: this.target(endpoint, ref), value: cert };
      },
      fetch: (target) => this.fetch(target, opts),
    });
  }

  /** Reference a single certificate by `{ name }` or `{ uuid }`. */
  get(id: CertificateRef, opts: ScopeOptions = {}): CertificateHandle<Certificate> {
    return new CertificateHandle(this, {
      locate: () => this.locate(id, opts, (endpoint) => this.#find(endpoint, id, opts)),
      fetch: (target) => this.fetch(target, opts),
    });
  }

  /**
   * Reference every certificate matching a ref — one per metro that holds it.
   *
   * @example
   * await ukc.certificates.each({ name: "star-example" }).delete();
   */
  each(id: CertificateRef, opts: ScopeOptions = {}): CertificateSet {
    return new CertificateSet(async () => {
      const located = await this.locateAll(id, opts, (endpoint) => this.#find(endpoint, id, opts));
      return located.map(
        (hit) =>
          new CertificateHandle<Certificate>(this, {
            locate: () => Promise.resolve(hit),
            fetch: (target) => this.fetch(target, opts),
          }),
      );
    });
  }

  /** Lazily iterate every certificate in scope, following pagination per metro. */
  list(opts: ListCertificatesOptions = {}): AsyncGenerator<Certificate, void, void> {
    const { details, pageSize, ...rest } = opts;
    const self = this;
    return (async function* () {
      const endpoints = await self.endpoints(opts);
      yield* fanout(endpoints, (endpoint) =>
        paginate({
          pageSize,
          cursor: (c) => c.uuid,
          fetchPage: async ({ count, from }) => {
            const res = await self.api.getCertificates({
              count,
              from,
              details,
              ...self.call(endpoint, rest),
            });
            return unwrapList(res, "certificates").map((c) => withMetro(c, endpoint.metro));
          },
        }),
      );
    })();
  }

  /** Delete one or more certificates, in whichever metros hold them. */
  delete(ids: CertificateRef | ReadonlyArray<CertificateRef>, opts: ScopeOptions = {}) {
    return this.#bulk(ids, opts, (group) =>
      this.api.deleteCertificates({ body: group.refs, ...this.call(group.endpoint, opts) }),
    );
  }

  /** Update a single certificate. Shorthand for `get(id).update(...)`. */
  update(id: CertificateRef, spec: CertificateUpdate, opts: ScopeOptions = {}) {
    return this.get(id, opts).update(spec);
  }

  /**
   * Read one certificate's full details from the metro it was located in.
   *
   * @internal Used by {@link CertificateHandle}.
   */
  fetch(target: MetroTarget, opts: ScopeOptions = {}): Promise<Certificate> {
    return firstTagged(
      this.api.getCertificates({
        ...toQuery(target.ref),
        details: true,
        ...this.call(target, opts),
      }),
      "certificates",
      target.metro,
      `certificate ${describeRef(target.ref)}`,
    ) as Promise<Certificate>;
  }

  /** Look for one certificate in one metro; absent is not a failure. */
  #find(
    endpoint: MetroEndpoint,
    id: CertificateRef,
    opts: ScopeOptions,
  ): Promise<models.Certificate | undefined> {
    return orAbsent(
      this.api
        .getCertificates({ ...toQuery(id), details: true, ...this.call(endpoint, opts) })
        .then((res) => unwrapList(res, "certificates")[0]),
    );
  }

  async #bulk<R extends ListEnvelope<"certificates">>(
    ids: CertificateRef | ReadonlyArray<CertificateRef>,
    opts: ScopeOptions,
    each: (group: MetroGroup) => Promise<R>,
  ): Promise<Array<WithMetro<EntryOf<R, "certificates">>>> {
    const groups = await this.groupByMetro(ids, opts, (endpoint, ref) =>
      this.#find(endpoint, ref, opts),
    );
    return this.runGroups(groups, (group) =>
      listTagged(each(group), "certificates", group.endpoint.metro),
    );
  }
}
