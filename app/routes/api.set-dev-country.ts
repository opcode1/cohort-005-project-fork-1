import { redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.set-dev-country";
import { identity, safeRedirect } from "~/lib/identity.server";
import { parseFormData } from "~/lib/validation";

const setDevCountrySchema = z.object({
  country: z.string().length(2).or(z.literal("")).transform((v) => v || null),
});

export async function action({ request, url }: Route.ActionArgs) {
  const formData = await request.formData();
  const parsed = parseFormData(formData, setDevCountrySchema);

  const country = parsed.success ? parsed.data.country : null;

  const cookie = await identity.setDevCountry(request, country);

  return redirect(safeRedirect(url.searchParams.get("redirectTo"), "/"), {
    headers: { "Set-Cookie": cookie },
  });
}
