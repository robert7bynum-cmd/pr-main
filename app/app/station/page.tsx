import { redirect } from "next/navigation";
import { getQueue, getDepartmentCounts, getTeam, getDepartments } from "@/lib/queue/reports";
import { getMe } from "@/lib/queue/actions-db";
import { StationBoard } from "@/components/staff/station-board";

export const dynamic = "force-dynamic";
export const metadata = { title: "Station board — ProResponse" };

/**
 * The counter view. Same data as the queue, scoped to the signed-in account's
 * own departments, handed to a board laid out for a screen across a room.
 * Station accounts are sent here from /app; anyone else can open it from the
 * menu — a supervisor propping a tablet on the shed wall wants the same thing.
 */
export default async function StationPage({
  searchParams,
}: {
  searchParams: Promise<{ dept?: string }>;
}) {
  const { dept } = await searchParams;

  const me = await getMe();
  if (!me) redirect("/login");

  const [rows, departments, team, allDepartments] = await Promise.all([
    getQueue(dept, "mine"),
    getDepartmentCounts("mine"),
    getTeam(),
    getDepartments(),
  ]);

  // An empty board and a broken one look the same; say which. See /app.
  const elsewhere = rows.length === 0 ? (await getQueue(undefined, "all")).length : 0;

  return (
    <StationBoard
      courseId={me.course_id}
      courseName={me.course_name}
      meId={me.profile_id}
      meKind={me.account_kind}
      rows={rows}
      departments={departments}
      allDepartments={allDepartments}
      team={team}
      dept={dept}
      elsewhere={elsewhere}
    />
  );
}
