package dev.momo.task;
/** Server-confirmed shield events for this player, never inferred from full health. */
public final class ShieldBlocks {
 public static final ShieldBlocks CURRENT=new ShieldBlocks();
 private Object world;private long count;
 public void changeWorld(Object value){if(world!=value){world=value;count=0;}}
 public void record(Object value,int target,int player){if(value==null||target!=player)return;changeWorld(value);count++;}
 public long count(Object value){return value!=null&&world==value?count:0;}
}
