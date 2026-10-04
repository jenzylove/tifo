// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A shop's public profile: handle, branding, links and product catalog (JSON).
/// The owner is always msg.sender, so only the shop's own wallet can change its page.
contract TifoShops {
    struct Shop {
        address owner;
        string handle;
        string profile;
        uint64 updatedAt;
    }

    Shop[] internal shops;
    mapping(address => uint256) internal indexOf; // 1-based
    mapping(bytes32 => address) public ownerOfHandle;

    event ShopSaved(address indexed owner, string handle);

    error BadHandle();
    error HandleTaken();
    error ProfileTooLong();

    function save(string calldata handle, string calldata profile) external {
        if (!_validHandle(bytes(handle))) revert BadHandle();
        if (bytes(profile).length > 12_000) revert ProfileTooLong();
        bytes32 key = keccak256(bytes(handle));
        address holder = ownerOfHandle[key];
        if (holder != address(0) && holder != msg.sender) revert HandleTaken();

        uint256 i = indexOf[msg.sender];
        if (i == 0) {
            shops.push(Shop(msg.sender, handle, profile, uint64(block.timestamp)));
            indexOf[msg.sender] = shops.length;
        } else {
            Shop storage s = shops[i - 1];
            bytes32 old = keccak256(bytes(s.handle));
            if (old != key) delete ownerOfHandle[old];
            s.handle = handle;
            s.profile = profile;
            s.updatedAt = uint64(block.timestamp);
        }
        ownerOfHandle[key] = msg.sender;
        emit ShopSaved(msg.sender, handle);
    }

    function shopOf(address owner) external view returns (Shop memory s) {
        uint256 i = indexOf[owner];
        if (i != 0) s = shops[i - 1];
    }

    function shopByHandle(string calldata handle) external view returns (Shop memory s) {
        uint256 i = indexOf[ownerOfHandle[keccak256(bytes(handle))]];
        if (i != 0) s = shops[i - 1];
    }

    function shopsCount() external view returns (uint256) {
        return shops.length;
    }

    function getShops(uint256 start, uint256 n) external view returns (Shop[] memory out) {
        uint256 end = start + n > shops.length ? shops.length : start + n;
        if (start >= end) return out;
        out = new Shop[](end - start);
        for (uint256 i = start; i < end; i++) out[i - start] = shops[i];
    }

    /// 3 to 24 characters: lowercase letters, digits and dashes, not starting or ending with a dash.
    function _validHandle(bytes memory h) internal pure returns (bool) {
        if (h.length < 3 || h.length > 24) return false;
        if (h[0] == "-" || h[h.length - 1] == "-") return false;
        for (uint256 i; i < h.length; i++) {
            bytes1 c = h[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")) return false;
        }
        return true;
    }
}
