package dev.momo.task;
/** A predicted slot click is not an authoritative inventory gain. */
public final class InventoryEvidence {
 private final int before;private int revision,lastMutation;
 public InventoryEvidence(int before,int revision){this.before=before;this.revision=revision;}
 public void mutated(int tick,int currentRevision){lastMutation=tick;revision=currentRevision;}
 public boolean acknowledged(int tick,int currentRevision){return tick-lastMutation>=4&&currentRevision!=revision;}
 public boolean settled(int tick,int count,boolean cursorEmpty,int currentRevision){return acknowledged(tick,currentRevision)&&count>before&&cursorEmpty;}
}
