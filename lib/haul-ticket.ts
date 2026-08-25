// Starting the haul ticket for a load a hauler has taken.
//
// Shared by the accept route (which does this automatically) and the "start
// the ticket" button on the hauler's loads list, which is the way back when
// the automatic attempt didn't land — it is best-effort by design, since an
// acceptance that silently rolled back because of a ticket hiccup would leave
// the hauler with no idea what happened.

import type { createAdminClient } from '@/lib/supabase-admin';
import type { HaulerLoad } from '@/lib/haulers';

type Admin = ReturnType<typeof createAdminClient>;

// Everything the office already knows is carried across so the driver isn't
// re-keying it off the load they just accepted. The company's own details come
// off the haulers row, so a company that later corrects its name doesn't leave
// old tickets wrong.
export async function startHaulTicket(
  db: Admin,
  load: HaulerLoad,
  userId: string,
  actor: { full_name?: string | null; email?: string | null },
): Promise<string | null> {
  // Who is driving is whoever the load was assigned to — often, but not
  // always, the person who accepted it. A one-truck outfit takes its own
  // loads, so the accepter and the driver are the same person.
  const driverId = load.driver_id || userId;
  try {
    const [{ data: company }, { data: unit }, { data: driver }] = await Promise.all([
      db.from('haulers').select('name').eq('id', load.hauler_id).maybeSingle(),
      load.equipment_id
        ? db.from('hauler_equipment').select('unit_number, equipment_type')
            .eq('id', load.equipment_id).maybeSingle()
        : Promise.resolve({ data: null }),
      db.from('profiles').select('full_name, email').eq('id', driverId).maybeSingle(),
    ]);
    const named = driver as { full_name: string | null; email: string } | null;

    const { data: wo, error } = await db
      .from('work_orders')
      .insert({
        status: 'draft',
        submitted_by: userId,
        hauler_id: load.hauler_id,
        hauler_load_id: load.id,
        order_id: load.order_id,
        trucking_company: (company as { name: string } | null)?.name ?? null,
        assigned_to: driverId,
        driver_name: named?.full_name || named?.email || actor.full_name || actor.email || null,
        unit_number: (unit as { unit_number: string | null } | null)?.unit_number ?? null,
        equipment_type:
          (unit as { equipment_type: string | null } | null)?.equipment_type ?? load.equipment_type,
        job_number: load.job_number,
        job_name: load.job_name,
        job_address: load.pickup && load.dropoff
          ? `${load.pickup} → ${load.dropoff}`
          : (load.pickup || load.dropoff),
        phase_code: load.phase_code,
        job_date: load.job_date,
        // What the hauler is owed. Never the customer's rate — that lives on
        // the order, which haulers cannot read.
        rate: load.rate,
        notes: load.notes,
      })
      .select('id')
      .single();
    if (error || !wo) return null;

    await db.from('hauler_loads').update({ work_order_id: wo.id }).eq('id', load.id);
    return wo.id as string;
  } catch {
    return null;
  }
}
