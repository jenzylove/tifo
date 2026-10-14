// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Float {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title TifoFloat
/// @notice USDC set aside to sell for naira. A buyer pays naira through the payment provider; when the provider
/// confirms it, the server (the releaser) sends the matching USDC from this float to the buyer's Tifo wallet.
/// Every release carries a reference that can be used once, so a repeated webhook cannot pay twice. The releaser also
/// has two ceilings, one per release and one per UTC day, so a stolen releaser key can only drain a small, known amount.
/// The releaser has no other power: it cannot withdraw, change limits or change itself. Only the owner does that.
contract TifoFloat {
    IERC20Float public immutable usdc;
    address public immutable owner;
    address public releaser; // the server key that pays buyers
    uint256 public perRelease; // the most one release may send
    uint256 public perDay; // the most all releases may send in one UTC day

    mapping(bytes32 => bool) public released; // references already paid
    mapping(uint256 => uint256) internal dayTotal; // UTC day number => USDC released that day

    event Released(bytes32 indexed ref, address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event LimitsSet(uint256 perRelease, uint256 perDay);
    event ReleaserSet(address releaser);

    error NotOwner();
    error NotReleaser();
    error AlreadyReleased();
    error OverLimit();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address usdc_, address owner_, address releaser_, uint256 perRelease_, uint256 perDay_) {
        require(usdc_ != address(0) && owner_ != address(0) && releaser_ != address(0), "zero");
        usdc = IERC20Float(usdc_);
        owner = owner_;
        releaser = releaser_;
        perRelease = perRelease_;
        perDay = perDay_;
        emit LimitsSet(perRelease_, perDay_);
        emit ReleaserSet(releaser_);
    }

    // ------------------------------------------------------------ releaser

    /// @notice Pay a buyer once for a confirmed naira payment. `ref` is the hash of the provider's checkout id.
    function release(bytes32 ref, address to, uint256 amount) external {
        if (msg.sender != releaser) revert NotReleaser();
        if (released[ref]) revert AlreadyReleased();
        require(to != address(0) && amount != 0, "bad release");
        if (amount > perRelease) revert OverLimit();
        uint256 day = block.timestamp / 1 days;
        uint256 total = dayTotal[day] + amount;
        if (total > perDay) revert OverLimit();
        released[ref] = true;
        dayTotal[day] = total;
        if (!usdc.transfer(to, amount)) revert TransferFailed();
        emit Released(ref, to, amount);
    }

    // --------------------------------------------------------------- owner

    /// @notice Take USDC back out of the float. Only the owner, and only to an address the owner names.
    function withdraw(address to, uint256 amount) external onlyOwner {
        if (!usdc.transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    function setLimits(uint256 perRelease_, uint256 perDay_) external onlyOwner {
        perRelease = perRelease_;
        perDay = perDay_;
        emit LimitsSet(perRelease_, perDay_);
    }

    function setReleaser(address releaser_) external onlyOwner {
        require(releaser_ != address(0), "zero");
        releaser = releaser_;
        emit ReleaserSet(releaser_);
    }

    // --------------------------------------------------------------- views

    /// @notice What has been released so far in the current UTC day.
    function releasedToday() external view returns (uint256) {
        return dayTotal[block.timestamp / 1 days];
    }
}
