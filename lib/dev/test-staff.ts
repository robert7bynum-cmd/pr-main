/**
 * Throwaway staff for the live suites, and the means to remove them again.
 *
 * The live suites used to sign in as the seeded demo personas. Those are gone —
 * the owner asked for every piece of demo data out of production, and a club
 * that is one real manager and twenty-four placards is the truthful state. A
 * suite that needs "a supervisor in Course Maintenance" or "a line staff
 * member who was not paged" therefore has to bring its own, and take it away
 * afterwards. Nothing here survives a run: the accounts are created with a
 * password that exists only in this process, and teardown deletes the auth
 * users, which cascades the profiles, their departments, their devices and
 * their notifications.
 *
 * What does NOT cascade is report_events.actor_id and reports.claimed_by /
 * resolved_by. A suite that lets a test account touch a report must delete
 * that report (deleteReport below) before teardown, or teardown fails on the
 * foreign key — deliberately, because the alternative is a real report whose
 * history names a person who no longer exists.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

export interface TestPerson {
  id: string;
  email: string;
  full_name: string;
  role: "manager" | "supervisor" | "staff";
}

export interface TestStaff {
  manager: TestPerson;
  supervisor: TestPerson;   // Course Maintenance
  staff: TestPerson;        // Pro Shop
  password: string;
  courseId: string;
  teardown: () => Promise<void>;
}

const DOMAIN = "proresponse.test";

export async function provisionTestStaff(admin: SupabaseClient): Promise<TestStaff> {
  const stamp = Date.now().toString(36);
  const password = `T-${randomBytes(12).toString("base64url")}`;

  const { data: course, error: cErr } = await admin.from("courses").select("id").limit(1).single();
  if (cErr || !course) throw new Error(`no course: ${cErr?.message}`);
  const { data: depts, error: dErr } = await admin.from("departments").select("id, key");
  if (dErr) throw new Error(dErr.message);
  const deptId = (key: string) => {
    const d = (depts ?? []).find((x: { key: string }) => x.key === key);
    if (!d) throw new Error(`no department with key ${key}`);
    return (d as { id: string }).id;
  };

  const make = async (
    role: TestPerson["role"], label: string, departmentIds: string[],
  ): Promise<TestPerson> => {
    const email = `probe-${label}-${stamp}@${DOMAIN}`;
    const full_name = `Test ${label[0].toUpperCase()}${label.slice(1)} (automated)`;
    const { data: created, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (error || !created.user) throw new Error(`createUser ${email}: ${error?.message}`);
    const id = created.user.id;
    const { error: pErr } = await admin.from("profiles").insert({
      id, course_id: course.id, full_name, email, role, active: true, on_duty: true,
    });
    if (pErr) throw new Error(`profile ${email}: ${pErr.message}`);
    if (departmentIds.length) {
      const { error: sdErr } = await admin.from("staff_departments")
        .insert(departmentIds.map((department_id) => ({ profile_id: id, department_id })));
      if (sdErr) throw new Error(`departments ${email}: ${sdErr.message}`);
    }
    return { id, email, full_name, role };
  };

  const manager = await make("manager", "manager", (depts ?? []).map((d: { id: string }) => d.id));
  const supervisor = await make("supervisor", "supervisor", [deptId("maintenance")]);
  const staff = await make("staff", "proshop", [deptId("pro_shop")]);

  const teardown = async () => {
    // A fixture manager that invited someone has a row in the admin audit log
    // naming it as the actor, and that reference does not cascade — on purpose,
    // since an audit trail pointing at nobody is worthless. The log entries a
    // throwaway account made during a test are removed with it.
    const ids = [staff.id, supervisor.id, manager.id];
    const { error: aeErr } = await admin.from("admin_events").delete().in("actor_id", ids);
    if (aeErr) console.log(`  !! could not clear admin_events for fixtures: ${aeErr.message}`);
    for (const p of [staff, supervisor, manager]) {
      const { error } = await admin.auth.admin.deleteUser(p.id);
      if (error) {
        // Loud, not swallowed: a leftover account is exactly what the owner
        // asked never to accumulate again.
        console.log(`  !! could not remove ${p.email}: ${error.message}`);
      }
    }
  };

  return { manager, supervisor, staff, password, courseId: course.id, teardown };
}

/** Remove a report a suite created, and everything hanging off it. */
export async function deleteReport(admin: SupabaseClient, reportId: string): Promise<void> {
  for (const table of ["notifications", "report_events", "triage_queue"]) {
    const { error } = await admin.from(table).delete().eq("report_id", reportId);
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  const { error } = await admin.from("reports").delete().eq("id", reportId);
  if (error) throw new Error(`reports: ${error.message}`);
}
