// PROTOTYPE (wayfinder: "Prototype the web push permission prompt").
// refreshUserToken target: mints a fresh SuprSend token for the session's user.
import { data } from "react-router";
import type { Route } from "./+types/api.notification-token";
import { getCurrentUserId } from "~/lib/session";
import {
  prototypeDistinctId,
  prototypeMintUserToken,
} from "~/lib/notifications-prototype.server";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("Not signed in", { status: 401 });
  const token = prototypeMintUserToken(prototypeDistinctId(userId));
  if (!token) throw data("No signing key", { status: 500 });
  return { token };
}
