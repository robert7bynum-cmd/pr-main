import { redirect } from "next/navigation";

/**
 * There is no marketing site. Staff land on the queue (which redirects to
 * sign-in if needed); members only ever arrive via a placard link.
 */
export default function Home() {
  redirect("/app");
}
