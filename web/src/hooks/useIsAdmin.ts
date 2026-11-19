// Modified for Triune.
import { useEffect, useSyncExternalStore } from "react";
import { getCurrentIsAdmin, resolveIdentity, subscribeIdentity } from "@/lib/identity";

// Mode-agnostic admin gate, sourced from the `/v1/me` identity probe
// (the shared `users.is_admin` column). Unlike `useMe`, which reads the
// accounts-only `/auth/me` endpoint, this works in EVERY auth mode —
// header, accounts, AND OIDC/SSO — so admin chrome (the Members /
// Policies settings sections) can surface under OIDC where `/auth/me`
// doesn't exist.
export function useIsAdmin(): boolean {
  const admin = useSyncExternalStore(subscribeIdentity, getCurrentIsAdmin, getCurrentIsAdmin);
  useEffect(() => {
    void resolveIdentity();
  }, []);
  return admin;
}
