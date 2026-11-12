package dev.momo.mixin;

import dev.momo.CompanionClient;

import net.minecraft.client.MinecraftClient;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/** Ordinary client handlers retain vanilla reach, cooldown and server validation. */
@Mixin(MinecraftClient.class)
public interface GameplayInputAccess {
 @Invoker("handleBlockBreaking") void momo$breakBlock(boolean breaking);
 @Invoker("doItemUse") void momo$useItem();
 @Invoker("doAttack") boolean momo$attack();
}
