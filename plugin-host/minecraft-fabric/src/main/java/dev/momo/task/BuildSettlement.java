package dev.momo.task;
/** Wait for server block facts after the local builder stops, not after task start. */
final class BuildSettlement {
 private final int grace;private int inactiveTicks;
 BuildSettlement(int grace){if(grace<1)throw new IllegalArgumentException("Invalid grace");this.grace=grace;}
 boolean missingReceiptExpired(boolean active){inactiveTicks=active?0:inactiveTicks+1;return inactiveTicks>=grace;}
}
