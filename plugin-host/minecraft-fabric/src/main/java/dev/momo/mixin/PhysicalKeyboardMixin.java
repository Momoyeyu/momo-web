package dev.momo.mixin;
import dev.momo.CompanionClient;
import net.minecraft.client.Keyboard;
import net.minecraft.client.MinecraftClient;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Respect the player's actual bindings rather than assuming WASD. Menus pause separately. */
@Mixin(Keyboard.class)
public abstract class PhysicalKeyboardMixin {
 @Inject(method="onKey",at=@At("HEAD"))
 private void momo$key(long window,int key,int scan,int action,int modifiers,CallbackInfo ci){
  var c=MinecraftClient.getInstance();
  if(action==0||!c.isWindowFocused()||window!=c.getWindow().getHandle())return;
  if(c.currentScreen!=null){if(CompanionClient.ownsCurrentScreen())CompanionClient.physicalInput();return;}
  var o=c.options;
  for(var binding:new net.minecraft.client.option.KeyBinding[]{o.forwardKey,o.backKey,o.leftKey,o.rightKey,o.jumpKey,o.sneakKey,o.sprintKey,o.attackKey,o.useKey,o.dropKey,o.swapHandsKey,o.inventoryKey})if(binding.matchesKey(key,scan)){CompanionClient.physicalInput();return;}
  for(var binding:o.hotbarKeys)if(binding.matchesKey(key,scan)){CompanionClient.physicalInput();return;}
 }
}
