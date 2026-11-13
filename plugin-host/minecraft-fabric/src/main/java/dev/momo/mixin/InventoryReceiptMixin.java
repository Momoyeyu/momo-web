package dev.momo.mixin;
import dev.momo.task.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.client.network.ClientPlayerInteractionManager;
import net.minecraft.network.packet.Packet;
import net.minecraft.network.packet.c2s.play.ClickSlotC2SPacket;
import net.minecraft.network.packet.s2c.play.InventoryS2CPacket;
import net.minecraft.network.packet.s2c.play.ScreenHandlerSlotUpdateS2CPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
@Mixin(ClientPlayNetworkHandler.class)
public abstract class InventoryReceiptMixin {
 @Inject(method="onInventory",at=@At("TAIL"))
 private void momo$inventory(InventoryS2CPacket packet,CallbackInfo ci){
  var c=MinecraftClient.getInstance();
  if(c.player!=null&&c.world!=null&&c.player.currentScreenHandler.syncId==packet.getSyncId())InventoryReceipts.CURRENT.record(c.world,packet.getSyncId(),packet.getRevision(),packet.getContents().stream().map(SlotConfirmation::fingerprint).toList(),SlotConfirmation.fingerprint(packet.getCursorStack()));
 }
 @Inject(method="onScreenHandlerSlotUpdate",at=@At("TAIL"))
 private void momo$slot(ScreenHandlerSlotUpdateS2CPacket packet,CallbackInfo ci){
  var c=MinecraftClient.getInstance();
  if(c.player!=null&&c.world!=null&&c.player.currentScreenHandler.syncId==packet.getSyncId())InventoryReceipts.CURRENT.recordSlot(c.world,packet.getSyncId(),packet.getSlot(),SlotConfirmation.fingerprint(packet.getStack()));
 }
}
