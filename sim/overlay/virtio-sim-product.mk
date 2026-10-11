# Include directly from the top-level Lineage product, not via inherit-product.
# Android expands inherited overlay lists in place: an override inside the
# device branch cannot outrank an earlier Wi-Fi-only product branch.
ifneq ($(TARGET_NO_TELEPHONY),true)
PRODUCT_PACKAGE_OVERLAYS := device/virt/virtio-common/framework-overlay $(filter-out device/virt/virtio-common/framework-overlay,$(PRODUCT_PACKAGE_OVERLAYS))
endif
