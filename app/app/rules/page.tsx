import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/queue/actions-db";
import { RulesEditor, type Rule, type Dept } from "@/components/rules/rules-editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Routing & SLAs — ProResponse" };

export default async function RulesPage() {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!["manager", "owner"].includes(me.role)) redirect("/app");

  const supabase = await createClient();
  const [{ data: rules }, { data: departments }] = await Promise.all([
    supabase.rpc("routing_rules_for_club"),
    supabase.from("departments").select("id, name").order("sort_order"),
  ]);

  return (
    <main>
      <div className="mx-auto max-w-[48rem] px-5 pb-24">
        <header className="flex items-baseline justify-between pt-9 pb-2">
          <div>
            <h1 className="text-[1.5rem] font-semibold tracking-tight">Routing &amp; SLAs</h1>
                      </div>
        </header>

        {/* Stated plainly, because it is the thing people assume works the other
            way round: the model reads the words, this table decides the person. */}
        <p className="mb-5 text-[13px] leading-relaxed text-ink-secondary">
          These decide who gets told and how long they have. Reports are sorted into
          categories automatically, but this table — not the software&apos;s judgement —
          decides which team each category reaches.
        </p>

        <RulesEditor
          initial={(rules ?? []) as Rule[]}
          departments={(departments ?? []) as Dept[]}
        />
      </div>
    </main>
  );
}
