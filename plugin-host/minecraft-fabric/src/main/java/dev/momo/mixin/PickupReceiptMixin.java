package dev.momo.mixin;
import dev.momo.task.PickupLedger;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.network.packet.s2c.play.ItemPickupAnimationS2CPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
@Mixin(ClientPlayNetworkHandler.class)
public abstract class PickupReceiptMixin {
 // TAIL executes after vanilla's main-thread packet handoff, not on the Netty reader.
 @Inject(method="onItemPickupAnimation",at=@At("TAIL"))
 private void momo$pickup(ItemPickupAnimationS2CPacket packet,CallbackInfo ci){
  var c=MinecraftClient.getInstance();
  PickupLedger.CURRENT.record(c.world,packet.getEntityId(),packet.getCollectorEntityId(),packet.getStackAmount());
 }
}
