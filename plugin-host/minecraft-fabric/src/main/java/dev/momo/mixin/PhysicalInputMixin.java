package dev.momo.mixin;
import dev.momo.CompanionClient;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.Mouse;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** GLFW user input wins. Automated skills do not synthesize these callbacks. */
@Mixin(Mouse.class)
public abstract class PhysicalInputMixin {
 @Unique private boolean momo$tracking;
 @Unique private double momo$lastX,momo$lastY;
 @Inject(method="onMouseButton",at=@At("HEAD"))
 private void momo$button(long window,int button,int action,int mods,CallbackInfo ci){if(action==1&&MinecraftClient.getInstance().isWindowFocused()&&MinecraftClient.getInstance().currentScreen==null)CompanionClient.physicalInput();}
 @Inject(method="onMouseScroll",at=@At("HEAD"))
 private void momo$scroll(long window,double x,double y,CallbackInfo ci){if(MinecraftClient.getInstance().isWindowFocused()&&MinecraftClient.getInstance().currentScreen==null)CompanionClient.physicalInput();}
 @Inject(method="onCursorPos",at=@At("HEAD"))
 private void momo$cursor(long window,double x,double y,CallbackInfo ci){
  var client=MinecraftClient.getInstance();boolean active=CompanionClient.controlling()&&client.isWindowFocused()&&client.mouse.isCursorLocked();
  if(active&&momo$tracking&&(Math.abs(x-momo$lastX)+Math.abs(y-momo$lastY)>.5))CompanionClient.physicalInput();
  momo$tracking=active;momo$lastX=x;momo$lastY=y;
 }
}
