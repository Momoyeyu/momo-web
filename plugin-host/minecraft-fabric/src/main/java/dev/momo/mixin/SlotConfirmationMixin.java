package dev.momo.mixin;
import dev.momo.task.SlotConfirmation;
import net.minecraft.client.network.ClientPlayerInteractionManager;
import net.minecraft.network.packet.Packet;
import net.minecraft.network.packet.c2s.play.ClickSlotC2SPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
@Mixin(ClientPlayerInteractionManager.class)
public abstract class SlotConfirmationMixin {
 @ModifyArg(method="clickSlot",at=@At(value="INVOKE",target="Lnet/minecraft/client/network/ClientPlayNetworkHandler;sendPacket(Lnet/minecraft/network/packet/Packet;)V"),index=0)
 private Packet<?> momo$verify(Packet<?> packet){
  if(SlotConfirmation.requested()&&packet instanceof ClickSlotC2SPacket click)return new ClickSlotC2SPacket(click.getSyncId(),SlotConfirmation.resyncRevision(click.getRevision()),click.getSlot(),click.getButton(),click.getActionType(),click.getStack(),click.getModifiedStacks());
  return packet;
 }
}
