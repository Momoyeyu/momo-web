package dev.momo.mixin;

import dev.momo.CompanionClient;

import net.minecraft.client.MinecraftClient;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(MinecraftClient.class)
public abstract class GameplayInputMixin {

 @Inject(method="handleBlockBreaking",at=@At("HEAD"),cancellable=true)
 private void keepControlledMining(boolean breaking,CallbackInfo callback) {
  // Vanilla's idle input pass must not cancel an authorized held mining action.
  if(CompanionClient.suppressVanillaBreaking())callback.cancel();
 }
}
