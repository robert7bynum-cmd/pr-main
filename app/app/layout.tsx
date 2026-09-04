import { redirect } from "next/navigation";
import { getMe } from "@/lib/queue/actions-db";
import { AppShell } from "@/components/shell/app-shell";

/**
 * Every staff page shares one shell, so navigation and the account menu are in
 * the same place regardless of where you are. Also the single place the session
 * is checked.
 */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  if (!me) redirect("/login");

  return (
    <AppShell user={{ full_name: me.full_name, role: me.role, course_name: me.course_name }}>
      {children}
    </AppShell>
  );
}
