import ODataModel from "sap/ui/model/odata/v4/ODataModel";

export interface Session { isAdmin: boolean; email: string; }
export interface Entitlement { catalogId: string; catalogName: string; isDefault: boolean; modelIds: string[]; unrestricted: boolean; }

let sessionPromise: Promise<Session> | null = null;

/** whoami (POST) once per page — the shell resolves the same call for its own role gating. */
export function load(model: ODataModel): Promise<Session> {
  if (!sessionPromise) {
    const binding = model.bindContext("/whoami(...)");
    sessionPromise = binding.invoke().then(() => {
      const r = binding.getBoundContext().getObject() as any;
      return { isAdmin: !!r.isAdmin, email: r.user || "" };
    });
  }
  return sessionPromise;
}

/** myEntitlement() — re-read on demand (catalog changes alter it). */
export function entitlement(model: ODataModel): Promise<Entitlement> {
  const binding = model.bindContext("/myEntitlement(...)");
  return binding.invoke().then(() => {
    const r = binding.getBoundContext().getObject() as any;
    return { catalogId: r.catalog?.ID, catalogName: r.catalog?.name, isDefault: !!r.catalog?.isDefault, modelIds: r.modelIds || [], unrestricted: !!r.unrestricted };
  });
}

/** Test seam. */
export function _reset(): void { sessionPromise = null; }
