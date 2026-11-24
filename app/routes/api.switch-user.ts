import { redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.switch-user";
import { identity, safeRedirect } from "~/lib/identity.server";
import { parseFormData } from "~/lib/validation";

const switchUserSchema = z.object({
  userId: z.coerce.number().int().positive("Invalid user ID"),
});

export async function action({ request, url }: Route.ActionArgs) {
  const formData = await request.formData();
  const parsed = parseFormData(formData, switchUserSchema);

  if (!parsed.success) {
    throw new Response("Invalid user ID", { status: 400 });
  }

  const cookie = await identity.switchUser(request, parsed.data.userId);

  return redirect(safeRedirect(url.searchParams.get("redirectTo"), "/"), {
    headers: { "Set-Cookie": cookie },
  });
}
