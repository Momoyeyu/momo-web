package dev.momo.mixin;
import dev.momo.task.BlockReceipts;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.network.packet.s2c.play.BlockUpdateS2CPacket;
import net.minecraft.network.packet.s2c.play.ChunkDeltaUpdateS2CPacket;
import net.minecraft.registry.Registries;
import net.minecraft.util.math.BlockPos;
import net.minecraft.block.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
@Mixin(ClientPlayNetworkHandler.class)
public abstract class BlockReceiptMixin {
 @Unique private static void record(BlockPos pos,BlockState state){BlockReceipts.CURRENT.record(MinecraftClient.getInstance().world,pos.getX(),pos.getY(),pos.getZ(),Registries.BLOCK.getId(state.getBlock()).toString(),state.toString());}
 // TAIL runs after vanilla's main-thread packet handoff and world update.
 @Inject(method="onBlockUpdate",at=@At("TAIL"))
 private void momo$block(BlockUpdateS2CPacket packet,CallbackInfo ci){record(packet.getPos(),packet.getState());}
 @Inject(method="onChunkDeltaUpdate",at=@At("TAIL"))
 private void momo$delta(ChunkDeltaUpdateS2CPacket packet,CallbackInfo ci){packet.visitUpdates(BlockReceiptMixin::record);}
}
