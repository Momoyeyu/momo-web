package dev.momo.task;
import java.util.List;
import net.minecraft.client.MinecraftClient;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.screen.slot.SlotActionType;
/** Request vanilla resynchronization for our normal clicks; never inject inventory state. */
public final class SlotConfirmation {
 private static boolean requested;
 public static boolean requested(){return requested;}
 public static int resyncRevision(int revision){return (revision+16384)&32767;}
 public static String fingerprint(ItemStack stack){return Registries.ITEM.getId(stack.getItem())+":"+stack.getCount()+":"+stack.getComponents();}
 public static List<String> snapshot(MinecraftClient c){return c.player.currentScreenHandler.slots.stream().map(slot->fingerprint(slot.getStack())).toList();}
 public static void click(MinecraftClient c,int slot,int button,SlotActionType mode){
  boolean previous=requested;requested=true;
  try{c.interactionManager.clickSlot(c.player.currentScreenHandler.syncId,slot,button,mode,c.player);}finally{requested=previous;}
 }
}
