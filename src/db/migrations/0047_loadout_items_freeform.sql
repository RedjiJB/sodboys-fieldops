-- Lets a loadout item reference a placeholder label instead of a real
-- asset/consumable row -- closes a real gap found in the WhatsApp
-- transcript: a crew member's "Personal Loadout" (knife, blade, boots...)
-- was blocked entirely because none of those existed as registered
-- assets/consumables yet, and the old CHECK required exactly one of
-- asset_id/consumable_id. freeform_label is the third option, not a
-- replacement -- an item still upgrades to a real asset_id/consumable_id
-- once one is registered, at which point a future item edit can drop the
-- label (no automatic migration between the two; out of scope here).
ALTER TABLE loadout_items ADD COLUMN freeform_label TEXT;

ALTER TABLE loadout_items DROP CONSTRAINT loadout_items_exactly_one_target;

ALTER TABLE loadout_items ADD CONSTRAINT loadout_items_exactly_one_target CHECK (
  (asset_id IS NOT NULL)::int + (consumable_id IS NOT NULL)::int + (freeform_label IS NOT NULL)::int = 1
);
