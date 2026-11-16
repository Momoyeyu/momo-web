package dev.momo.mixin;
import dev.momo.CompanionClient;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.Mouse;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** GLFW user input wins. Automated skills do not synthesize these callbacks. */
@Mixin(Mouse.class)
public abstract class PhysicalInputMixin {
 @Shadow private boolean hasResolutionChanged;
 @Shadow private double x,y;
 @Inject(method="onMouseButton",at=@At("HEAD"))
 private void momo$button(long window,int button,int action,int mods,CallbackInfo ci){
  var c=MinecraftClient.getInstance();if(window!=c.getWindow().getHandle())return;
  CompanionClient.physicalButton(button,action!=0);
  if(action==1&&c.isWindowFocused()&&(c.currentScreen==null||CompanionClient.ownsCurrentScreen()))CompanionClient.physicalInput();
 }
 @Inject(method="onMouseScroll",at=@At("HEAD"))
 private void momo$scroll(long window,double x,double y,CallbackInfo ci){var c=MinecraftClient.getInstance();if(window==c.getWindow().getHandle()&&c.isWindowFocused()&&(c.currentScreen==null||CompanionClient.ownsCurrentScreen()))CompanionClient.physicalInput();}
 @Inject(method="onCursorPos",at=@At("HEAD"))
 private void momo$cursor(long window,double newX,double newY,CallbackInfo ci){
  var client=MinecraftClient.getInstance();boolean active=CompanionClient.controlling()&&client.isWindowFocused()&&client.mouse.isCursorLocked();
  if(window!=client.getWindow().getHandle())return;
  // Vanilla updates x/y before GLFW re-centering and ignores the first callback
  // after lock/resize. A separate coordinate history mistakes those warps for
  // physical movement when no intervening unlocked callback was delivered.
  if(dev.momo.task.PhysicalInputState.pointerMoved(active,hasResolutionChanged,x,y,newX,newY))CompanionClient.physicalInput();
 }
}
