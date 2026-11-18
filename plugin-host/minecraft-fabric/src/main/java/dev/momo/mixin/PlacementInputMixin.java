package dev.momo.mixin;

import dev.momo.CompanionClient;
import dev.momo.task.GameSkills;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.input.Input;
import net.minecraft.client.input.KeyboardInput;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Add the placement stance to vanilla input without toggling a player's key binding. */
@Mixin(KeyboardInput.class)
public abstract class PlacementInputMixin extends Input {
 @Inject(method="tick",at=@At("RETURN"))
 private void momo$placementSneak(boolean slowDown,float factor,CallbackInfo ci){
  var client=MinecraftClient.getInstance();
  if(CompanionClient.controlling()&&GameSkills.sneaksForPlacement()&&client.isWindowFocused()&&client.currentScreen==null)
   sneaking=true;
 }
}
