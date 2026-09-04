import QRCode from "qrcode";
import type { PlacardSet } from "@/lib/placards/queries";

/**
 * Printable placards.
 *
 * Rendered as real page content rather than a generated PDF so it prints from
 * any browser with no download step, and so a club can print one replacement
 * sign without regenerating a whole sheet.
 *
 * QR codes are generated server-side as SVG: they stay sharp at any size, which
 * matters because these get printed large and mounted outdoors.
 */
export async function PlacardSheet({ set }: { set: PlacardSet }) {
  const codes = await Promise.all(
    set.placards.map(async (p) => ({
      ...p,
      svg: await QRCode.toString(p.url, {
        type: "svg",
        margin: 0,
        // High error correction: a scratched or partly obscured sign on a tee
        // box still scans, which is the whole point of putting it outdoors.
        errorCorrectionLevel: "H",
        color: { dark: "#111111", light: "#00000000" },
      }),
    })),
  );

  return (
    <div className="placards">
      {codes.map((p) => (
        <article key={p.token} className="placard">
          <p className="club">{set.courseName}</p>
          <div className="rule" style={{ backgroundColor: set.branding.primary }} />

          <h2 className="where">
            {p.holeNumber ? `Hole ${p.holeNumber}` : p.locationName}
          </h2>

          <div className="qr" dangerouslySetInnerHTML={{ __html: p.svg }} />

          <p className="cta">Something needs attention?</p>
          <p className="sub">Scan to tell the team. No app, no account.</p>
          {!p.active && <p className="retired">RETIRED — do not post</p>}
        </article>
      ))}
    </div>
  );
}
