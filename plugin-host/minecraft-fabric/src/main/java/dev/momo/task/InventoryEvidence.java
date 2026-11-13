package dev.momo.task;
/** A predicted slot click is not an authoritative inventory gain. */
public final class InventoryEvidence {
 private final int before,revision;private int lastMutation;
 public InventoryEvidence(int before,int revision){this.before=before;this.revision=revision;}
 public void mutated(int tick){lastMutation=tick;}
 public boolean settled(int tick,int count,boolean cursorEmpty,int currentRevision){return tick-lastMutation>=4&&count>before&&cursorEmpty&&currentRevision>revision;}
}
