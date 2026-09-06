import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/queue/actions-db";
import { LocationsTable, type LocationRow } from "@/components/settings/locations-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Locations & placards — ProResponse" };

export default async function LocationsPage() {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!["manager", "owner"].includes(me.role)) redirect("/app");

  const supabase = await createClient();
  const { data } = await supabase
    .from("locations")
    .select("id, kind, hole_number, name, sort_order, active, qr_codes(token, active)")
    .order("sort_order");

  const rows = ((data ?? []) as unknown as {
    id: string; kind: string; hole_number: number | null; name: string;
    sort_order: number; active: boolean;
    qr_codes: { token: string; active: boolean }[] | null;
  }[]).map<LocationRow>((l) => {
    const live = (l.qr_codes ?? []).find((q) => q.active);
    return {
      id: l.id, kind: l.kind, hole_number: l.hole_number, name: l.name,
      sort_order: l.sort_order, active: l.active,
      // The prefix only. The full token leaves the server as a QR code on the
      // placard page and nowhere else.
      token_prefix: live ? live.token.slice(0, 6) : null,
    };
  });

  const active = rows.filter((r) => r.active).length;

  return (
    <main>
      <div className="mx-auto max-w-[48rem] px-5 pb-24">
        <header className="pt-10 pb-6">
          <h1 className="font-display text-[1.75rem] tracking-tight">Locations &amp; placards</h1>
          <p className="mt-1.5 text-[13px] text-ink-muted">
            {active} in use · every location with a code is a sign on the course
          </p>
        </header>

        <p className="mb-5 rounded-card border border-tone-dept-border bg-tone-dept-fill px-5 py-4 text-[13px] leading-relaxed text-tone-dept-ink">
          Rename a hole or add somewhere new here. A location is retired, never
          deleted, so old reports keep their place. Issuing a new code stops the
          current sign working the moment you press the button — print the
          replacement from{" "}
          <a href="/app/placards" className="font-medium underline underline-offset-2">Placards</a>
          {" "}before taking the old one down.
        </p>

        <LocationsTable locations={rows} />
      </div>
    </main>
  );
}
