-- A failed check always keeps the old version serving: the switch this column held changed nothing.
ALTER TABLE "apps" DROP COLUMN "autoRollback";
