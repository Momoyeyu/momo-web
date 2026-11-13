package dev.momo.task;
import java.util.ArrayDeque;
/** Server pickup facts survive entity removal and finite-plan step handoff. Game-thread only. */
public final class PickupLedger {
 public static final PickupLedger CURRENT=new PickupLedger();
 public record Receipt(long seq,Object world,int entityId,int collectorId,int amount){}
 private long sequence;private Object currentWorld;private final ArrayDeque<Receipt> recent=new ArrayDeque<>();
 public long cursor(){return sequence;}
 public void changeWorld(Object world){if(world!=currentWorld){recent.clear();currentWorld=world;}}
 public void record(Object world,int entity,int collector,int amount){if(world==null||amount<1)return;changeWorld(world);recent.add(new Receipt(++sequence,world,entity,collector,amount));while(recent.size()>128)recent.removeFirst();}
 public Receipt since(Object world,int entity,int collector,long after){return recent.stream().filter(r->r.seq>after&&r.world==world&&r.entityId==entity&&r.collectorId==collector).findFirst().orElse(null);}
}
