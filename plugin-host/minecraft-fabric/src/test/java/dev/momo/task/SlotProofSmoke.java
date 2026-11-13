package dev.momo.task;
import java.util.*;
public final class SlotProofSmoke {
 static void check(boolean value,String reason){if(!value)throw new AssertionError(reason);}
 public static void main(String[] args){
  Object world=new Object();InventoryReceipts ledger=new InventoryReceipts();
  SlotProof proof=new SlotProof(List.of("dirt:2","air","iron:1"),"air");
  proof.mutated(1,ledger.cursor(),List.of("air","dirt:2","iron:1"),"air");
  check(!proof.settled(10,null),"prediction alone cannot prove a slot swap");
  ledger.record(world,0,2,List.of("dirt:2","air","iron:2"),"air");
  check(!proof.settled(10,ledger.after(world,0,0)),"unrelated furnace/slot update cannot verify the intended swap");
  ledger.record(world,0,3,List.of("air","dirt:2","iron:2"),"air");
  check(proof.settled(10,ledger.after(world,0,0)),"actual matching swapped slots verify the action");
  check(ledger.after(new Object(),0,0)==null&&ledger.after(world,1,0)==null,"world and handler scope");
  SlotProof noOp=new SlotProof(List.of("air","iron:1"),"air");noOp.mutated(1,0,List.of("air","iron:1"),"air");
  check(!noOp.settled(10,ledger.after(world,0,0)),"a no-op is not verified by unrelated changes");
  SlotProof button=new SlotProof(List.of("sword","lapis","air"),"air");button.buttonSlots(Set.of(0,1));button.mutated(1,ledger.cursor(),List.of("sword","lapis","air"),"air");
  check(!button.settledButton(10,Map.of(2,"iron")),"unrelated output cannot prove an enchant button");
  check(button.settledButton(10,Map.of(0,"enchanted_sword")),"actual server target change proves the button");
  check(StationOutputs.indices("minecraft:furnace").equals(Set.of(2)),"furnace input/backpack excluded");
  check(StationOutputs.indices("minecraft:brewing_stand").equals(Set.of(0,1,2)),"brewing bottle outputs");
  check(!StationOutputs.hasButtons("minecraft:furnace"),"automatic cooking changes cannot prove an unsupported button");
  check(!PlacementEvidence.matches("minecraft:dirt","minecraft:air",true,10,1),"air correction is not placement");
  check(!PlacementEvidence.matches("minecraft:dirt","minecraft:dirt",false,1,1),"old packet cannot prove a new placement");
  check(PlacementEvidence.matches("minecraft:dirt","minecraft:dirt",false,2,1),"matching actual placed block");
  System.out.println("PASS intended slot and actual placement proof");
 }
}
