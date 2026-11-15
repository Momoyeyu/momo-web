package dev.momo.mixin;
import dev.momo.task.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.client.network.ClientPlayerInteractionManager;
import net.minecraft.network.packet.Packet;
import net.minecraft.network.packet.c2s.play.ClickSlotC2SPacket;
import net.minecraft.network.packet.s2c.play.InventoryS2CPacket;
import net.minecraft.network.packet.s2c.play.ScreenHandlerSlotUpdateS2CPacket;
import net.minecraft.network.packet.s2c.play.OpenScreenS2CPacket;
import net.minecraft.network.packet.s2c.play.OpenHorseScreenS2CPacket;
import net.minecraft.network.packet.s2c.play.SignEditorOpenS2CPacket;
import net.minecraft.network.packet.s2c.play.OpenWrittenBookS2CPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
@Mixin(ClientPlayNetworkHandler.class)
public abstract class InventoryReceiptMixin {
 @Inject(method="onOpenScreen",at=@At("TAIL"))
 private void momo$open(OpenScreenS2CPacket packet,CallbackInfo ci){
  var c=MinecraftClient.getInstance();
  if(c.player!=null&&c.world!=null&&c.currentScreen instanceof net.minecraft.client.gui.screen.ingame.HandledScreen<?> &&c.player.currentScreenHandler.syncId==packet.getSyncId())InventoryReceipts.CURRENT.recordWindow(c.world,c.currentScreen,"container:"+packet.getSyncId(),packet.getSyncId());
 }
 @Inject(method="onOpenHorseScreen",at=@At("TAIL"))
 private void momo$horse(OpenHorseScreenS2CPacket packet,CallbackInfo ci){
  var c=MinecraftClient.getInstance();
  if(c.player!=null&&c.world!=null&&c.currentScreen instanceof net.minecraft.client.gui.screen.ingame.HandledScreen<?> &&c.player.currentScreenHandler.syncId==packet.getSyncId())InventoryReceipts.CURRENT.recordWindow(c.world,c.currentScreen,"entity:"+packet.getHorseId(),packet.getSyncId());
 }
 @Inject(method="onSignEditorOpen",at=@At("TAIL"))
 private void momo$sign(SignEditorOpenS2CPacket packet,CallbackInfo ci){
  var c=MinecraftClient.getInstance();var pos=packet.getPos();
  if(c.player!=null&&c.world!=null&&c.currentScreen instanceof net.minecraft.client.gui.screen.ingame.AbstractSignEditScreen)InventoryReceipts.CURRENT.recordWindow(c.world,c.currentScreen,"block:"+pos.getX()+","+pos.getY()+","+pos.getZ(),c.player.currentScreenHandler.syncId);
 }
 @Inject(method="onOpenWrittenBook",at=@At("TAIL"))
 private void momo$book(OpenWrittenBookS2CPacket packet,CallbackInfo ci){
  var c=MinecraftClient.getInstance();
  if(c.player!=null&&c.world!=null&&c.currentScreen instanceof net.minecraft.client.gui.screen.ingame.BookScreen)InventoryReceipts.CURRENT.recordWindow(c.world,c.currentScreen,"hand:"+packet.getHand().name(),c.player.currentScreenHandler.syncId);
 }
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
