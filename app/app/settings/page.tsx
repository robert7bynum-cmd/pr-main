import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/queue/actions-db";
import { ClubSettingsForm, type CourseSettings } from "@/components/settings/club-settings-form";
import { DepartmentsEditor, type DepartmentRow } from "@/components/settings/departments-editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Club settings — ProResponse" };

export default async function SettingsPage() {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!["manager", "owner"].includes(me.role)) redirect("/app");

  const supabase = await createClient();
  const [{ data: courses }, { data: departments }] = await Promise.all([
    supabase.from("courses").select("name, timezone, settings").limit(1),
    supabase.from("departments").select("id, key, name, sort_order").order("sort_order"),
  ]);

  const course = courses?.[0] as { name: string; timezone: string; settings: Record<string, unknown> } | undefined;
  if (!course) redirect("/app");

  const settings = course.settings ?? {};
  const quiet = (settings.quiet_hours ?? {}) as { start?: string; end?: string };
  const initial: CourseSettings = {
    name: course.name,
    timezone: course.timezone,
    publicUrl: typeof settings.public_url === "string" ? settings.public_url : "",
    quietStart: quiet.start ?? "",
    quietEnd: quiet.end ?? "",
  };

  return (
    <main>
      <div className="mx-auto max-w-[48rem] px-5 pb-28">
        <header className="pt-10 pb-6">
          <h1 className="font-display text-[1.75rem] tracking-tight">Club settings</h1>
          <p className="mt-1.5 text-[13px] text-ink-muted">
            Name, timezone, the address on every sign, and when the club sleeps.
          </p>
        </header>

        <div className="space-y-4">
          <ClubSettingsForm initial={initial} />
          <DepartmentsEditor departments={(departments ?? []) as DepartmentRow[]} />
        </div>
      </div>
    </main>
  );
}
