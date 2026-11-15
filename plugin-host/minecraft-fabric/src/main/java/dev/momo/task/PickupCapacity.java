package dev.momo.task;
import java.util.*;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ItemStack;
/** Capacity follows vanilla pickup destinations, not armor/crafting/container slots. */
final class PickupCapacity {
 record Space(boolean emptyDestination,boolean sameStack,int count,int limit){}
 static int room(List<Space> spaces){int result=0;for(var slot:spaces)if(slot.emptyDestination()||slot.sameStack())result+=Math.max(0,slot.limit()-slot.count());return result;}
 static int room(PlayerInventory inventory,ItemStack incoming){
  var spaces=new ArrayList<Space>();
  for(int i=0;i<36;i++)spaces.add(space(inventory,inventory.getStack(i),incoming,true));
  spaces.add(space(inventory,inventory.getStack(40),incoming,false));
  return room(spaces);
 }
 private static Space space(PlayerInventory inventory,ItemStack stored,ItemStack incoming,boolean emptyAllowed){
  return new Space(emptyAllowed&&stored.isEmpty(),!stored.isEmpty()&&stored.isStackable()&&ItemStack.areItemsAndComponentsEqual(stored,incoming),stored.getCount(),inventory.getMaxCount(incoming));
 }
 static void require(int room){if(room<=0)throw new TaskRuntime.Rejected("inventory_full");}
}
