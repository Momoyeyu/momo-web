package dev.momo.mixin;

import baritone.api.BaritoneAPI;
import baritone.api.utils.input.Input;
import dev.momo.CompanionClient;
import dev.momo.task.NavigationUseGuard;
import net.minecraft.block.DoorBlock;
import net.minecraft.block.FenceGateBlock;
import net.minecraft.block.TrapdoorBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.network.ClientPlayerInteractionManager;
import net.minecraft.util.ActionResult;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Baritone can request a door click before its new look rotation is applied. */
@Mixin(ClientPlayerInteractionManager.class)
public abstract class NavigationUseMixin {
 @Unique private static final StackWalker momo$callers=StackWalker.getInstance();
 @Unique private static boolean momo$automaticUse(){
  // Gate the bounded stack walk behind an active owned path and a forced click.
  // GameSkills (including a shield while chasing) must keep ordinary item use.
  return NavigationUseGuard.CURRENT.active()&&CompanionClient.controlling()&&!CompanionClient.physicalTakeoverPending()
   &&BaritoneAPI.getProvider().getPrimaryBaritone().getInputOverrideHandler().isInputForcedDown(Input.CLICK_RIGHT)
   &&momo$callers.walk(frames->frames.limit(16).anyMatch(frame->frame.getClassName().startsWith("baritone.")));
 }
 @Inject(method="interactBlock",at=@At("HEAD"),cancellable=true)
 private void momo$block(ClientPlayerEntity player,Hand hand,BlockHitResult hit,CallbackInfoReturnable<ActionResult> callback){
  if(!momo$automaticUse())return;
  var c=MinecraftClient.getInstance();if(c.world==null)return;
  var block=c.world.getBlockState(hit.getBlockPos()).getBlock();
  boolean passage=block instanceof DoorBlock||block instanceof FenceGateBlock||block instanceof TrapdoorBlock;
  if(NavigationUseGuard.CURRENT.block(true,false,passage))callback.setReturnValue(ActionResult.FAIL);
 }
 @Inject(method="interactItem",at=@At("HEAD"),cancellable=true)
 private void momo$item(net.minecraft.entity.player.PlayerEntity player,Hand hand,CallbackInfoReturnable<ActionResult> callback){
  // BlockPlaceHelper falls back to both held items after a failed block click.
  if(momo$automaticUse()&&NavigationUseGuard.CURRENT.block(true,false,false))callback.setReturnValue(ActionResult.FAIL);
 }
}
