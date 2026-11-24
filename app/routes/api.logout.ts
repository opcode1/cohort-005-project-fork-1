import { redirect } from "react-router";
import type { Route } from "./+types/api.logout";
import { identity } from "~/lib/identity.server";

export async function action({ request }: Route.ActionArgs) {
  const cookie = await identity.signOut(request);

  return redirect("/", {
    headers: { "Set-Cookie": cookie },
  });
}
