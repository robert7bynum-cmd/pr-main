import "server-only";

import { createClient } from "@/lib/supabase/server";
import { brandingFrom, type Branding } from "@/lib/branding";

export interface Placard {
  token: string;
  locationName: string;
  holeNumber: number | null;
  kind: string;
  active: boolean;
  url: string;
}

export interface PlacardSet {
  courseName: string;
  courseSlug: string;
  branding: Branding;
  placards: Placard[];
}

/**
 * Every placard for the caller's club, in the order they'd be printed.
 *
 * The URL is built from the request's own origin rather than a stored setting:
 * a code printed against the wrong host is a sign that has to be replaced, and
 * guessing here is how that happens.
 */
export async function getPlacards(origin: string): Promise<PlacardSet | null> {
  const supabase = await createClient();

  const [{ data: courses }, { data: rows }] = await Promise.all([
    supabase.from("courses").select("name, slug, settings").limit(1),
    supabase
      .from("qr_codes")
      .select("token, active, locations(name, hole_number, kind, sort_order)")
      .order("token"),
  ]);

  const course = courses?.[0];
  if (!course) return null;

  const placards = ((rows ?? []) as unknown as {
    token: string;
    active: boolean;
    locations: { name: string; hole_number: number | null; kind: string } | null;
  }[])
    .filter((r) => r.locations)
    .map((r) => ({
      token: r.token,
      locationName: r.locations!.name,
      holeNumber: r.locations!.hole_number,
      kind: r.locations!.kind,
      active: r.active,
      url: `${origin}/r/${course.slug}/${r.token}`,
    }))
    // Holes in play order, then facilities alphabetically — the order someone
    // walking the course would want them in.
    .sort((a, b) => {
      if (a.holeNumber && b.holeNumber) return a.holeNumber - b.holeNumber;
      if (a.holeNumber) return -1;
      if (b.holeNumber) return 1;
      return a.locationName.localeCompare(b.locationName);
    });

  return {
    courseName: course.name,
    courseSlug: course.slug,
    branding: brandingFrom(course.settings),
    placards,
  };
}
