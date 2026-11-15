package dev.momo.task;
import java.util.List;
public final class PickupCapacitySmoke {
 static void check(boolean ok,String reason){if(!ok)throw new AssertionError(reason);}
 public static void main(String[] args){
  check(PickupCapacity.room(List.of(new PickupCapacity.Space(false,true,64,64)))==0,"matching full stacks cannot accept more");
  check(PickupCapacity.room(List.of(new PickupCapacity.Space(false,true,63,64)))==1,"a full slot count is not full inventory when stacking has room");
  check(PickupCapacity.room(List.of(new PickupCapacity.Space(false,false,1,64)))==0,"same item with different components must not claim stacking room");
  check(PickupCapacity.room(List.of(new PickupCapacity.Space(true,false,0,16)))==16,"empty main slot uses actual incoming stack limit");
  check(PickupCapacity.room(List.of(new PickupCapacity.Space(false,false,0,64)))==0,"empty offhand is not an automatic pickup destination");
  check(PickupCapacity.room(List.of(new PickupCapacity.Space(false,true,15,16),new PickupCapacity.Space(true,false,0,16)))==17,"actual partial room adds up without assuming 64 stack size");
  check(PickupCapacity.room(List.of(new PickupCapacity.Space(false,true,70,64)))==0,"overfull or incompatible slot never creates negative capacity");
  try{PickupCapacity.require(0);throw new AssertionError("full inventory extraction allowed");}catch(TaskRuntime.Rejected expected){check(expected.getMessage().equals("inventory_full"),"capacity failure must not become unreachable");}
  PickupCapacity.require(1);
  System.out.println("PASS component-aware pickup capacity, slot limits and explicit full-inventory stop");
 }
}
